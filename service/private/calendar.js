/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
const { toArray } = require("@drumee/server-essentials");
const { Entity } = require("@drumee/server-core");

// Hard ceiling on the per-workspace task fan-out. A membership list this long is
// pathological rather than legitimate, and the alternative to a cap is a request
// that walks hundreds of databases. Anything dropped is LOGGED, never silently
// truncated — a calendar that quietly omits a workspace is worse than a slow one.
const MAX_WORKSPACES = 200;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Personal Calendar — the aggregated read behind the desk's Calendar screen.
 *
 * READ-ONLY by construction. Every write the Calendar performs goes back to the
 * service that owns the record (task.update / task.update_status / room.book /
 * room.update), addressed with the row's own hub_id, so ACL and the audit log
 * stay identical to editing the item from its folder. Nothing is written here,
 * and no state is duplicated: this endpoint is a union of two existing sources.
 *
 *   meetings — one indexed read of yp.meeting_schedule, the GLOBAL index the
 *              room service already maintains write-through for the reminder
 *              worker. No fan-out at all.
 *   tasks    — task_list_range per database: the caller's own (personal tasks)
 *              plus every workspace they belong to. This is an N+1 by nature;
 *              it is the price of tasks having no global index the way meetings
 *              do, and it is the thing a future yp.task_schedule would collapse.
 */
class __private_calendar extends Entity {
  /**
   * Strict YYYY-MM-DD or nothing.
   *
   * These values reach a stored procedure and, in the fallback path, string
   * concatenation — so they are validated as an allow-list pattern rather than
   * escaped. Anything else is a client bug and gets refused outright.
   */
  _needDate(key) {
    const raw = String(this.input.need(key) || "").trim();
    if (!YMD.test(raw)) {
      this.exception.user("INVALID_DATE_RANGE");
      return null;
    }
    return raw;
  }

  /** 'YYYY-MM-DD' → UNIX-epoch seconds at the start (or end) of that day. */
  _epoch(ymd, edge) {
    const Moment = require("moment");
    const m = Moment(ymd, "YYYY-MM-DD");
    if (!m.isValid()) return 0;
    return (edge === "end" ? m.endOf("day") : m.startOf("day")).unix();
  }

  /**
   * The caller's workspaces, keyed by hub id.
   *
   * show_hubs runs inside the caller's OWN database and lists what they hold a
   * membership row for — which is the only source that includes workspaces
   * owned by OTHER people. It deliberately excludes the dmz / personal / pool
   * areas, so the personal database is fetched separately below.
   */
  async _workspaces(dbName) {
    if (!dbName) return [];
    let rows = [];
    try {
      rows = toArray(await this.yp.await_proc(`${dbName}.show_hubs`)) || [];
    } catch (e) {
      this.warn && this.warn("[calendar] show_hubs failed", e && e.message);
      return [];
    }
    return rows.filter((h) => h && h.id && h.db_name);
  }

  /**
   * Tasks across every database the caller can see, normalized to the
   * calendar.list row contract.
   *
   * One failing workspace must not empty the whole calendar, so each database
   * is read independently and a failure is logged and skipped.
   */
  async _tasks(from, to, workspaces, ownDb) {
    const out = [];
    // Skipping one broken workspace is right; skipping EVERY one and calling
    // the result "nothing scheduled" is not. Counting the attempts is what
    // lets the caller tell those two apart — see list().
    let attempted = 0;
    let failed = 0;

    const collect = (rows, { hub_id, scope, workspaceName }) => {
      for (const r of toArray(rows) || []) {
        if (!r || !r.id) continue;
        out.push({
          kind: "task",
          id: r.id,
          hub_id,
          // The folder the task was created in. Provenance only — a task
          // belongs to its WORKSPACE now, not to this folder (see
          // alter_task_column_workspace_scope). Kept because the client uses
          // it to open the task in the right place.
          nid: r.nid || null,
          scope,
          // Where the task lives, as the user thinks of it: the workspace.
          // This used to name the FOLDER and fall back to the workspace, which
          // now reads as a lie — two tasks on the same board would claim to
          // come from different places purely because of where each was typed.
          // A personal task shows neither; the client renders "Personal".
          origin_name: scope === "personal" ? null : workspaceName || null,
          title: r.title || "",
          description: r.description || "",
          due_date: r.due_date || null,
          start_date: r.start_date || null,
          status: r.status || "todo",
          // Resolved server-side because a custom column lives in a workspace
          // database the calendar client never opens. NULL when that
          // workspace's columns were never seeded — the client falls back to
          // the four built-ins.
          status_label: r.status_label || null,
          status_theme: r.status_theme || null,
          priority: r.priority || "medium",
          // Workspace tasks are read-only from the Calendar: they are edited on
          // their workspace board, which is where the ACL that governs them is
          // enforced. The Calendar has no privilege of its own to check
          // against, so it must not offer an edit it cannot authorise.
          can_write: scope === "personal" ? 1 : 0,
          recur: null,
        });
      }
    };

    // Personal tasks — the caller's own database.
    if (ownDb) {
      attempted++;
      try {
        const rows = await this.yp.await_proc(
          `${ownDb}.task_list_range`,
          from,
          to
        );
        collect(rows, { hub_id: this.uid, scope: "personal" });
      } catch (e) {
        failed++;
        this.warn &&
          this.warn("[calendar] personal task_list_range failed", e && e.message);
      }
    }

    const capped = workspaces.slice(0, MAX_WORKSPACES);
    if (workspaces.length > capped.length) {
      this.warn &&
        this.warn(
          `[calendar] workspace fan-out capped: read ${capped.length} of ` +
            `${workspaces.length}; ${workspaces.length - capped.length} omitted`
        );
    }

    for (const hub of capped) {
      attempted++;
      try {
        const rows = await this.yp.await_proc(
          `${hub.db_name}.task_list_range`,
          from,
          to
        );
        collect(rows, {
          hub_id: hub.id,
          scope: "workspace",
          workspaceName: hub.name,
        });
      } catch (e) {
        // A workspace whose database has not been patched with
        // task_list_range yet lands here. Skip it rather than failing the
        // whole calendar.
        failed++;
        this.warn &&
          this.warn(
            `[calendar] task_list_range failed for ${hub.id}`,
            e && e.message
          );
      }
    }
    return { rows: out, attempted, failed };
  }

  /**
   * Meetings the caller organizes or attends, from the global index.
   *
   * Visibility is participation, not workspace membership: the index models who
   * is actually involved, and a personal calendar listing every colleague's
   * meeting in every shared workspace would be unusable.
   */
  async _meetings(fromEpoch, toEpoch, workspaces) {
    let rows = [];
    try {
      rows =
        toArray(
          await this.yp.await_proc(
            "meeting_schedule_range",
            this.uid,
            fromEpoch,
            toEpoch
          )
        ) || [];
    } catch (e) {
      this.warn &&
        this.warn("[calendar] meeting_schedule_range failed", e && e.message);
      return [];
    }

    const byHub = {};
    for (const h of workspaces) byHub[h.id] = h.name;

    return rows
      .filter((r) => r && r.id)
      .map((r) => {
        // A meeting booked from the personal hub is scoped to the caller's own
        // entity, which is also their uid.
        const personal = `${r.hub_id}` === `${this.uid}`;
        return {
          kind: "meeting",
          id: r.nid || r.id,
          hub_id: r.hub_id,
          nid: r.nid || null,
          scope: personal ? "personal" : "workspace",
          // Meetings live at the hub's home rather than inside a folder
          // (room.book writes pid: home_id), so the pill names the workspace —
          // the same thing a task's pill names now.
          origin_name: personal ? null : byHub[r.hub_id] || null,
          title: r.title || "",
          description: r.message || "",
          stime: Number(r.stime) || 0,
          etime: Number(r.etime) || 0,
          status: "todo",
          priority: "medium",
          // room.update is creator-only (NOT_MEETING_OWNER), so nobody else
          // could reschedule it even if the UI offered to.
          can_write: `${r.created_by}` === `${this.uid}` ? 1 : 0,
          // Guarded: parseJSON logs a WARN with a full stack trace on empty
          // input, and a non-recurring meeting stores recur as '' — so every
          // ordinary meeting was writing a fake error into the service log on
          // every calendar open. "No recurrence" is the common case, not a
          // parse failure.
          recur: r.recur ? this.parseJSON(r.recur) || null : null,
        };
      });
  }

  /**
   * GET calendar.list
   *
   * Params: from, to (YYYY-MM-DD, inclusive), kinds (optional array —
   * omit for both). Answers one flat, time-sorted list; see the row contract in
   * the client's skeleton/helpers.js.
   */
  async list() {
    const from = this._needDate("from");
    if (!from) return;
    const to = this._needDate("to");
    if (!to) return;
    if (to < from) {
      this.exception.user("INVALID_DATE_RANGE");
      return;
    }

    let kinds = this.input.use("kinds", null);
    if (kinds && !Array.isArray(kinds)) kinds = [kinds];
    const wantTasks = !kinds || kinds.includes("task");
    const wantMeetings = !kinds || kinds.includes("meeting");

    let ownDb = null;
    try {
      ownDb = (this.user.toJSON() || {}).db_name || null;
    } catch (e) {
      this.warn && this.warn("[calendar] own db_name unavailable", e && e.message);
    }

    // Needed by BOTH halves: the task fan-out reads them, and the meeting rows
    // borrow their names for the provenance pill.
    const workspaces = await this._workspaces(ownDb);

    const rows = [];
    if (wantMeetings) {
      rows.push(
        ...(await this._meetings(
          this._epoch(from, "start"),
          this._epoch(to, "end"),
          workspaces
        ))
      );
    }
    if (wantTasks) {
      const t = await this._tasks(from, to, workspaces, ownDb);
      rows.push(...t.rows);
      // Every single source failed. That is a broken deployment — an undeployed
      // task_list_range is exactly how this presents — not an empty calendar,
      // and the two are indistinguishable to the client once we answer []. Say
      // so instead: a calendar that reports a fault is debuggable, one that
      // quietly renders nothing is not. A PARTIAL failure still degrades
      // silently, which is the point of the per-workspace catch.
      if (t.attempted > 0 && t.failed === t.attempted) {
        this.exception.user("CALENDAR_UNAVAILABLE");
        return;
      }
    }

    // One time-ordered list. A task is all-day (no stime), so it sorts by its
    // date at midnight — which puts it above that day's timed meetings, the
    // same order the grids draw.
    const at = (r) =>
      r.kind === "meeting"
        ? r.stime || 0
        : this._epoch(r.due_date || from, "start");
    rows.sort((a, b) => at(a) - at(b));

    // output.list (not the raw call_proc handler): row unwrapping collapses a
    // single-row result set into a bare object, which every calendar consumer
    // would read as "nothing scheduled". Same guard room.list carries.
    this.output.list(rows);
  }
}

module.exports = __private_calendar;
