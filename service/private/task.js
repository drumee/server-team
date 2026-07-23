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

const { Attr, RedisStore, toArray } = require('@drumee/server-essentials');
const { isEmpty } = require('lodash');
const { Entity } = require('@drumee/server-core');

// Built-in Kanban columns. Custom columns live in the task_column table and
// use their row id as the task.status key — see _isValidStatus().
const VALID_STATUSES = ['todo', 'in_progress', 'to_review', 'complete'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const VALID_THEMES = [
  'default', 'orange', 'yellow', 'green', 'cyan',
  'blue', 'purple', 'pink', 'red',
];

class __private_task extends Entity {

  constructor(...args) {
    super(...args);
    this.list = this.list.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.update_status = this.update_status.bind(this);
    this.update_assignee = this.update_assignee.bind(this);
    this.delete = this.delete.bind(this);
    this.link_file = this.link_file.bind(this);
    this.unlink_file = this.unlink_file.bind(this);
    this.get_linked_files = this.get_linked_files.bind(this);
    this.link_label = this.link_label.bind(this);
    this.unlink_label = this.unlink_label.bind(this);
    this.get_labels = this.get_labels.bind(this);
    this.search_files = this.search_files.bind(this);
    this.comment_list = this.comment_list.bind(this);
    this.comment_create = this.comment_create.bind(this);
    this.comment_update = this.comment_update.bind(this);
    this.comment_delete = this.comment_delete.bind(this);
    this.comment_react = this.comment_react.bind(this);
    this.activity = this.activity.bind(this);
    this.column_list = this.column_list.bind(this);
    this.column_create = this.column_create.bind(this);
    this.column_update = this.column_update.bind(this);
    this.column_delete = this.column_delete.bind(this);
    this.column_reorder = this.column_reorder.bind(this);
    this.column_watch_list = this.column_watch_list.bind(this);
    this.column_watch_set = this.column_watch_set.bind(this);
    this.column_watch_unset = this.column_watch_unset.bind(this);
  }

  /**
   * A status key is valid when it's one of the built-in columns or the id of
   * an existing column (task_column row) in the SAME folder scope.
   *
   * The scope matters: built-in ids are literal status keys stored once per
   * scope, so an unscoped lookup would accept a key that only exists on some
   * other board.
   */
  async _isValidStatus(status, nid) {
    if (VALID_STATUSES.includes(status)) return true;
    if (!status || !/^[A-Za-z0-9_-]{1,32}$/.test(status)) return false;
    const col = await this.db.await_proc('task_column_get_v2', status, nid);
    return !isEmpty(col);
  }

  /**
   * Whether a status/column key is a "done" column (is_done = 1) in this
   * folder scope. Completion is column-driven, so this replaces the old
   * literal `status === 'complete'` checks — a renamed or user-created done
   * column still counts as complete.
   */
  async _isDoneColumn(status, nid) {
    try {
      const col = await this.db.await_proc('task_column_get_v2', status, nid);
      const row = Array.isArray(col) ? col[0] : col;
      return !!(row && Number(row.is_done));
    } catch (e) {
      return status === 'complete';
    }
  }

  /**
   * Broadcast a task event to every socket connected to the current hub
   * (sender excluded). Silently no-ops if hub_id is missing.
   */
  async _broadcast(service, data) {
    const hub_id = this.hub && this.hub.get(Attr.id);
    if (!hub_id) return;
    let dest = await this.yp.await_proc('entity_sockets', hub_id);
    dest = toArray(dest).filter((e) => e.uid != this.uid);
    if (isEmpty(dest)) return;
    await RedisStore.sendData(this.payload(data, { service }), dest);
  }

  /**
   * Notify members @-mentioned in a task description. Logs a `task_mention`
   * activity (surfaced by channel.list_notifications) and live-pushes to the
   * mentioned users' sockets so their activity badge updates immediately.
   * Mirrors the chat/channel mention path. `mentionUids` is the set to notify —
   * create() passes all tagged uids, update() passes only the newly-added ones.
   * `kind` marks a non-mention variant carried by the same row (currently only
   * 'reply' — a reply to your comment); omitted for real @-mentions, so their
   * stored data stays exactly as before.
   */
  async _notifyMentions(data, mentionUids, kind = null) {
    const uids = toArray(mentionUids).filter((u) => u && u !== this.uid);
    if (isEmpty(uids)) return;
    const hub_id = this.hub && this.hub.get(Attr.id);
    const task_id = data && data.id;
    // `nid` lets the notification click open the task's folder on its Task tab;
    // it is null for legacy/workspace-level tasks (opens the workspace root).
    const meta = {
      task_id,
      hub_id,
      title: (data && data.title) || '',
      nid: (data && data.nid) || null,
    };
    if (kind) meta.kind = kind;
    for (const target_uid of uids) {
      try {
        await this.yp.await_proc(
          'contact_log_activity',
          this.uid,
          target_uid,
          'task_mention',
          meta,
        );
      } catch (e) {
        this.warn('[task._notifyMentions] log failed:', e && e.message);
      }
    }
    try {
      const recipients = await this.yp.await_proc('user_sockets', uids);
      if (!isEmpty(recipients)) {
        await RedisStore.sendData(
          this.payload(
            { ...data, event: 'task_mention', hub_id, task_id },
            { service: 'task.mention' },
          ),
          recipients,
        );
      }
    } catch (e) {
      this.warn('[task._notifyMentions] push failed:', e && e.message);
    }
  }

  /**
   * Notify members who were just assigned to a task. Logs a `task_assigned`
   * activity via contact_log_activity (deduped per assigner/assignee/task) — it
   * surfaces in the assignee's All-activity feed through activity_get_feed_all's
   * generic contact branch, and is dismissable / toggle-aware like any contact
   * event. Also live-pushes to the assignees' sockets so their panel updates
   * immediately. Mirrors _notifyMentions. `assigneeUids` is the set to notify —
   * create() passes all assignees, update_assignee() passes only the newly-added
   * ones. Self is always excluded.
   */
  async _notifyAssignees(data, assigneeUids) {
    const uids = toArray(assigneeUids).filter((u) => u && u !== this.uid);
    if (isEmpty(uids)) return;
    // create()/update_assignee() hand us the SP result; normalise to the single
    // task row (the driver may return it wrapped in an array — cf. comment_create).
    const row = Array.isArray(data) ? data[0] : data;
    const hub_id = this.hub && this.hub.get(Attr.id);
    const task_id = row && row.id;
    // `nid` lets the notification click open the task's folder on its Task tab;
    // it is null for legacy/workspace-level tasks (opens the workspace root).
    const meta = {
      task_id,
      hub_id,
      title: (row && row.title) || '',
      nid: (row && row.nid) || null,
    };
    for (const target_uid of uids) {
      try {
        await this.yp.await_proc(
          'contact_log_activity',
          this.uid,
          target_uid,
          'task_assigned',
          meta,
        );
      } catch (e) {
        this.warn('[task._notifyAssignees] log failed:', e && e.message);
      }
    }
    try {
      const recipients = await this.yp.await_proc('user_sockets', uids);
      if (!isEmpty(recipients)) {
        await RedisStore.sendData(
          this.payload(
            { ...(row || {}), event: 'task_assigned', hub_id, task_id },
            { service: 'task.assigned' },
          ),
          recipients,
        );
      }
    } catch (e) {
      this.warn('[task._notifyAssignees] push failed:', e && e.message);
    }
  }

  /**
   * Notify everyone watching a column (bell toggle in the column header) that a
   * task in it changed. Mirrors _notifyAssignees: persist a deduped
   * `task_column_change` row (offline-safe, coalesced per column) then live-push
   * to online watchers. The actor is always excluded. `columnKeys` may be one
   * key or several (a status move affects both the source and target columns).
   */
  async _notifyColumnWatchers(row, columnKeys) {
    const r = Array.isArray(row) ? row[0] : row;
    if (!r) return;
    const keys = toArray(columnKeys).filter(Boolean);
    if (isEmpty(keys)) return;
    const nid = r.nid || '0';
    const hub_id = this.hub && this.hub.get(Attr.id);
    // Union of watchers across the affected column(s), actor excluded.
    const watchers = new Set();
    for (const key of keys) {
      try {
        const rows = await this.db.await_proc('task_column_watchers', nid, key);
        for (const w of toArray(rows)) {
          if (w && w.uid && w.uid !== this.uid) watchers.add(w.uid);
        }
      } catch (e) {
        this.warn('[task._notifyColumnWatchers] resolve failed:', e && e.message);
      }
    }
    const uids = Array.from(watchers);
    if (isEmpty(uids)) return;

    // The persisted/click meta names the column so the notification reads
    // "activity in <column>" and the click can open that folder's Task tab.
    const meta = {
      task_id: r.id,
      hub_id,
      nid,
      column_key: keys[0],
      title: r.title || '',
    };
    for (const target_uid of uids) {
      try {
        await this.yp.await_proc(
          'contact_log_activity',
          this.uid,
          target_uid,
          'task_column_change',
          meta,
        );
      } catch (e) {
        this.warn('[task._notifyColumnWatchers] log failed:', e && e.message);
      }
    }
    try {
      const recipients = await this.yp.await_proc('user_sockets', uids);
      if (!isEmpty(recipients)) {
        await RedisStore.sendData(
          this.payload(
            { ...(r || {}), event: 'task_column_change', hub_id, nid },
            { service: 'task.column_change' },
          ),
          recipients,
        );
      }
    } catch (e) {
      this.warn('[task._notifyColumnWatchers] push failed:', e && e.message);
    }
  }

  // Read a task's column/folder so mutations whose SP result doesn't carry the
  // row (comment_create) or runs after removal (delete) can still notify.
  async _taskColMeta(id) {
    try {
      return (
        toArray(
          await this.db.await_run(
            'SELECT id, status, nid, title FROM task WHERE id = ?',
            [id],
          ),
        )[0] || null
      );
    } catch (e) {
      this.warn('[task._taskColMeta] failed:', e && e.message);
      return null;
    }
  }

  /**
   * Append a row to the folder-scoped task activity feed (Project Health).
   * Best-effort: a logging failure must never break the mutation it follows.
   * For deletions call BEFORE the row is removed (the proc snapshots task.nid).
   */
  async _logActivity(task_id, action, meta = {}) {
    try {
      await this.db.await_run('CALL task_activity_log(?, ?, ?, ?)', [
        task_id,
        this.uid,
        action,
        JSON.stringify(meta || {}),
      ]);
    } catch (e) {
      this.warn('[task._logActivity] failed:', e && e.message);
    }
  }

  /**
   * Recent activity feed for a folder scope (Project Health view).
   * Params: nid, include_unscoped (mirror task.list), limit (default 30).
   */
  async activity() {
    const nid = this.input.use('nid', null);
    const include_unscoped = this.input.use('include_unscoped', 0) ? 1 : 0;
    const limit = Number(this.input.use('limit', 30)) || 30;
    const data = await this.db.await_run(
      'CALL task_activity_list(?, ?, ?)',
      [nid, include_unscoped, limit]
    );
    this.output.list(data);
  }

  /**
   * List tasks scoped to a folder node.
   * Params: nid (folder node id; null/absent = legacy unscoped), include_unscoped
   * (1 on the workspace-root view to also surface legacy nid-less tasks).
   */
  async list() {
    const nid = this.input.use('nid', null);
    const include_unscoped = this.input.use('include_unscoped', 0) ? 1 : 0;
    // await_run (not await_proc) preserves a JS null nid when binding.
    const data = await this.db.await_run(
      'CALL task_list(?, ?)',
      [nid, include_unscoped]
    );
    this.output.list(data);
  }

  /**
   * Validate that every uid in the list references a real drumate.
   * Returns the de-duplicated, cleaned uid array, or throws a user exception.
   */
  async _validateAssignees(uids) {
    const clean = [];
    for (const uid of uids) {
      if (!uid) continue;
      if (clean.includes(uid)) continue;
      const drumate = await this.yp.await_proc('drumate_exists', uid);
      if (isEmpty(drumate)) {
        this.exception.user('INVALID_ASSIGNEE');
        return null;
      }
      clean.push(uid);
    }
    return clean;
  }

  /**
   * Read the assignee set from the request, accepting the multi-assignee
   * `assignee_uids` array and falling back to the legacy single `assignee_uid`.
   * Returns null when the caller supplied neither key (i.e. "unchanged").
   */
  _readAssignees() {
    const raw = this.input.use('assignee_uids', null);
    if (raw != null) return toArray(raw);
    const single = this.input.use('assignee_uid', null);
    if (single != null) return single ? [single] : [];
    return null;
  }

  /**
   * Read the requested priority from the request BODY only.
   *
   * `priority` collides with the standard HTTP `Priority` request header
   * (RFC 9218 fetch-priority hints, e.g. "u=1, i"), which @drumee/server-core
   * merges into the input namespace alongside body params. As a result
   * this.input.use('priority') can return the browser-sent header value rather
   * than the field the FE submitted — which is why update() rejected
   * INVALID_PRIORITY on a real browser (header present) but not locally
   * (no such header). Reading _body sidesteps the collision.
   */
  _readPriority(def = null) {
    const body = this.input._body || {};
    return body.priority != null ? body.priority : def;
  }

  /**
   * Create a new task in the current hub (folder).
   * Params: title (required), description, status, priority, due_date,
   * start_date, assignee_uid (all optional)
   */
  async create() {
    const title = this.input.need(Attr.title);
    const description = this.input.use('description', null);
    let status = this.input.use(Attr.status, 'todo');
    let priority = this._readPriority('medium');
    const due_date = this.input.use('due_date', null);
    // Optional range start (Duration toggle). null = single-date task.
    const start_date = this.input.use('start_date', null);
    // Folder scope: media node id of the folder the task belongs to (nullable).
    const nid = this.input.use('nid', null);
    // Multi-assignee: array (or legacy single). null/[] = unassigned.
    const assignees = (await this._validateAssignees(this._readAssignees() || []));
    if (assignees == null) return; // invalid assignee — exception already raised

    if (!(await this._isValidStatus(status, nid))) status = 'todo';
    if (!VALID_PRIORITIES.includes(priority)) priority = 'medium';

    const id = await this.yp.await_func('uniqueId');
    // Bypass `await_proc` which coerces JS null to '' before binding —
    // STRICT_TRANS_TABLES rejects '' for nullable DATE / VARCHAR columns.
    let data = await this.db.await_run(
      'CALL task_create(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, title, description, status, priority, due_date, start_date, this.uid, nid]
    );
    // The DB layer swallows SQL errors (returns empty) — an empty result here
    // means the row was NOT inserted, e.g. a hub DB missing the task-v2
    // migrations (cf. column_create). Fail loudly instead of acking success.
    if (isEmpty(data)) {
      return this.exception.user('TASK_CREATE_FAILED');
    }
    if (assignees.length) {
      // Re-reads the row with assignee_uids populated, so the response/broadcast
      // reflect the assignments.
      data = await this.db.await_run(
        'CALL task_set_assignees(?, ?)',
        [id, assignees.join(',')]
      );
    }
    await this._logActivity(id, 'create', { title });
    await this._broadcast('task.create', data);
    // Every tagged member is newly mentioned on create.
    await this._notifyMentions(data, this.input.use('mention_uids', null));
    // Every assignee is newly assigned on create → notify them (self excluded).
    await this._notifyAssignees(data, assignees);
    // Notify watchers of the column the task landed in.
    const created = Array.isArray(data) ? data[0] : data;
    await this._notifyColumnWatchers(created, created && created.status);
    this.output.data(data);
  }

  /**
   * Update task title, description, priority, due_date, and/or start_date.
   * Params: id (required); title / description / priority / due_date /
   * start_date (optional).
   * For title / description / priority: omit the key to keep existing value.
   * For due_date / start_date: the value is always written through (pass null
   * to clear; start_date null = Duration toggle OFF).
   */
  async update() {
    const id = this.input.need(Attr.id);
    const title = this.input.use(Attr.title, null);
    const description = this.input.use('description', null);
    const priority = this._readPriority(null);
    const due_date = this.input.use('due_date', null);
    // Range start (Duration toggle). Always written through: null clears it
    // (toggle OFF), matching the due_date pass-through in task_update.
    const start_date = this.input.use('start_date', null);

    if (priority != null && !VALID_PRIORITIES.includes(priority)) {
      return this.exception.user('INVALID_PRIORITY');
    }

    const data = await this.db.await_run(
      'CALL task_update(?, ?, ?, ?, ?, ?)',
      [id, title, description, priority, due_date, start_date]
    );
    if (isEmpty(data)) {
      return this.exception.user('TASK_NOT_FOUND');
    }
    const row = Array.isArray(data) ? data[0] : data;
    await this._logActivity(id, 'update', { title: row && row.title });
    await this._broadcast('task.update', data);
    // Client sends only the newly-added mentions in `mention_uids`.
    await this._notifyMentions(data, this.input.use('mention_uids', null));
    // Notify watchers of the task's current column.
    await this._notifyColumnWatchers(row, row && row.status);
    this.output.data(data);
  }

  /**
   * Move a task to a different Kanban column.
   * Params: id (required), status (required — a built-in column key or a
   * custom task_column id)
   */
  async update_status() {
    const id = this.input.need(Attr.id);
    let status = this.input.need(Attr.status);

    // Capture the source column BEFORE the move so its watchers are told the
    // task left, in addition to the destination column's watchers. This also
    // yields the task's folder, which the status check needs: column ids are
    // scoped, so a key must be validated against THIS task's board rather than
    // any board in the workspace.
    const prev = await this._taskColMeta(id);
    if (!prev) {
      // Same code the proc would have produced below; resolved earlier now
      // that the task row is read up front.
      return this.exception.user('TASK_NOT_FOUND');
    }
    const prevStatus = prev.status;

    if (!(await this._isValidStatus(status, prev.nid))) {
      return this.exception.user('INVALID_STATUS');
    }

    const data = await this.db.await_proc('task_update_status', id, status);
    if (isEmpty(data)) {
      return this.exception.user('TASK_NOT_FOUND');
    }
    const row = Array.isArray(data) ? data[0] : data;
    await this._logActivity(
      id,
      // nid is unchanged by a column move, so the task's folder still scopes
      // the done-column lookup correctly.
      (await this._isDoneColumn(status, prev.nid)) ? 'complete' : 'status',
      { title: row && row.title, status },
    );
    await this._broadcast('task.update_status', data);
    const cols =
      prevStatus && prevStatus !== status ? [status, prevStatus] : [status];
    await this._notifyColumnWatchers(row, cols);
    this.output.data(data);
  }

  /**
   * Replace a task's assignee set (multi-assignee).
   * Params: id (required); assignee_uids (array — the full new set; [] clears
   * all). Legacy single `assignee_uid` is still accepted.
   */
  async update_assignee() {
    const id = this.input.need(Attr.id);
    const assignees = await this._validateAssignees(this._readAssignees() || []);
    if (assignees == null) return; // invalid assignee — exception already raised

    // Capture the prior assignee set BEFORE the replace so we notify only the
    // NEWLY-added members. task_set_assignees does a full DELETE+INSERT and does
    // not report the delta, so we diff against this snapshot. On lookup failure
    // we fall back to an empty set (worst case: dedupe in contact_log_activity
    // refreshes existing assignees' rows rather than stacking — no duplicates).
    let prior = new Set();
    try {
      const before = toArray(await this.db.await_run(
        'SELECT uid FROM task_assignee WHERE task_id = ?', [id]
      ));
      prior = new Set(before.map((r) => String(r.uid)));
    } catch (e) {
      this.warn('[task.update_assignee] prior assignee lookup failed:', e && e.message);
    }

    const data = await this.db.await_run(
      'CALL task_set_assignees(?, ?)',
      [id, assignees.join(',')]
    );
    if (isEmpty(data)) {
      return this.exception.user('TASK_NOT_FOUND');
    }
    await this._logActivity(id, 'assignee', {});
    await this._broadcast('task.update_assignee', data);
    // Notify only members added by this change (self excluded in _notifyAssignees).
    const added = assignees.filter((u) => !prior.has(String(u)));
    await this._notifyAssignees(data, added);
    this.output.data(data);
  }

  /**
   * Delete a task. Linked files and labels are removed by the SP.
   * Params: id (required)
   */
  async delete() {
    const id = this.input.need(Attr.id);
    // Snapshot the column BEFORE removal so watchers learn a task was deleted.
    const meta = await this._taskColMeta(id);
    // Log BEFORE the delete — task_activity_log snapshots the task's nid/title.
    await this._logActivity(id, 'update', { deleted: 1 });
    const data = await this.db.await_proc('task_delete', id);
    const result = { id, ...data };
    await this._broadcast('task.delete', result);
    if (meta) await this._notifyColumnWatchers(meta, meta.status);
    this.output.data(result);
  }

  /**
   * Link a file (media nid) to a task. Idempotent (INSERT IGNORE).
   * Params: task_id (required), file_nid (required)
   */
  async link_file() {
    const task_id  = this.input.need('task_id');
    const file_nid = this.input.need('file_nid');

    const data = await this.db.await_proc(
      'task_link_file',
      task_id,
      file_nid,
      this.uid
    );
    await this._logActivity(task_id, 'link_file', {});
    await this._broadcast('task.link_file', { task_id, files: data });
    this.output.list(data);
  }

  /**
   * Unlink a file from a task.
   * Params: task_id (required), file_nid (required)
   */
  async unlink_file() {
    const task_id  = this.input.need('task_id');
    const file_nid = this.input.need('file_nid');

    const data = await this.db.await_proc('task_unlink_file', task_id, file_nid);
    const result = { task_id, file_nid, ...data };
    await this._broadcast('task.unlink_file', result);
    this.output.data(result);
  }

  /**
   * Get all files linked to a task, with media metadata.
   * Params: task_id (required)
   */
  async get_linked_files() {
    const task_id = this.input.need('task_id');
    const data = await this.db.await_proc('task_get_linked_files', task_id);
    this.output.list(data);
  }

  /**
   * Link a label to a task. Idempotent.
   * Params: task_id (required), label_id (required)
   */
  async link_label() {
    const task_id  = this.input.need('task_id');
    const label_id = this.input.need('label_id');

    const data = await this.db.await_proc('task_link_label', task_id, label_id);
    await this._broadcast('task.link_label', { task_id, labels: data });
    this.output.list(data);
  }

  /**
   * Unlink a label from a task.
   * Params: task_id (required), label_id (required)
   */
  async unlink_label() {
    const task_id  = this.input.need('task_id');
    const label_id = this.input.need('label_id');

    const data = await this.db.await_proc('task_unlink_label', task_id, label_id);
    const result = { task_id, label_id, ...data };
    await this._broadcast('task.unlink_label', result);
    this.output.data(result);
  }

  /**
   * Get all labels attached to a task.
   * Params: task_id (required)
   */
  async get_labels() {
    const task_id = this.input.need('task_id');
    const data = await this.db.await_proc('task_get_labels', task_id);
    this.output.list(data);
  }

  /**
   * Search media files in the current hub that can be linked to a task.
   * Filters by user read-permission. Files already linked to task_id
   * (when provided) are excluded.
   * Params: pattern (optional — empty lists all linkable files, most-recent
   * first), task_id (optional), page (optional, default 1).
   */
  async search_files() {
    const pattern = this.input.use('pattern', '');
    const task_id = this.input.use('task_id', null);
    const page    = this.input.use('page', 1);

    // task_id may be null — await_run preserves the JS null when binding.
    const data = await this.db.await_run(
      'CALL task_search_linkable_files(?, ?, ?, ?)',
      [this.uid, task_id, pattern, page]
    );
    this.output.list(data);
  }

  /**
   * Notify members @-mentioned in a comment body. Reuses _notifyMentions with a
   * task-shaped context ({ id: task_id, title, nid }) so the activity reads
   * "mentioned you in <task>". Best-effort. `kind` is forwarded as-is ('reply'
   * for a reply to someone's comment).
   * The task's `nid` (its folder) MUST travel with the notification: without it
   * the click can only fall back to the workspace root instead of opening the
   * folder the task actually lives in.
   */
  async _notifyCommentMentions(task_id, mentionUids, kind = null) {
    if (isEmpty(toArray(mentionUids))) return;
    let title = '';
    let nid = null;
    try {
      const rows = await this.db.await_run('SELECT title, nid FROM task WHERE id = ?', [task_id]);
      const t = toArray(rows)[0];
      title = (t && t.title) || '';
      nid = (t && t.nid) || null;
    } catch (e) {
      this.warn('[task._notifyCommentMentions] title lookup failed:', e && e.message);
    }
    await this._notifyMentions({ id: task_id, title, nid }, mentionUids, kind);
  }

  /**
   * List a task's comments (flat, chronological). Author display is resolved
   * client-side from the hub member list.
   * Params: task_id (required).
   */
  async comment_list() {
    const task_id = this.input.need('task_id');
    const data = await this.db.await_proc('task_comment_list', task_id);
    this.output.list(data);
  }

  /**
   * Add a comment to a task. Body is marker form ("[@Name](user:uid) ...").
   * Params: task_id (required), body (required), mention_uids (optional).
   */
  async comment_create() {
    const task_id = this.input.need('task_id');
    const body = this.input.need('body');
    // parent_id (a reply's root comment) is nullable — await_run preserves the
    // JS null when binding (await_proc would coerce it to '').
    const parent_id = this.input.use('parent_id', null);
    const id = await this.yp.await_func('uniqueId');
    const data = await this.db.await_run(
      'CALL task_comment_create(?, ?, ?, ?, ?)',
      [id, task_id, this.uid, parent_id, body]
    );
    const row = Array.isArray(data) ? data[0] : data;
    await this._logActivity(task_id, 'comment', {});
    await this._broadcast('task.comment_create', row);
    // Notify @-mentioned members. On a reply, the parent author is notified too
    // — but as a 'reply', NOT a mention: they were never @-mentioned, and
    // labelling it "mentioned you" is what the notification wrongly claimed.
    const mentions = [...new Set(toArray(this.input.use('mention_uids', null)).filter(Boolean))];
    await this._notifyCommentMentions(task_id, mentions);
    if (parent_id) {
      try {
        const p = toArray(
          await this.db.await_run('SELECT author_uid FROM task_comment WHERE id = ?', [parent_id])
        )[0];
        // Already @-mentioned in the same comment → one notification, not two.
        // (_notifyMentions drops self, so replying to yourself notifies nobody.)
        if (p && p.author_uid && !mentions.includes(p.author_uid)) {
          await this._notifyCommentMentions(task_id, [p.author_uid], 'reply');
        }
      } catch (e) {
        this.warn('[task.comment_create] parent lookup failed:', e && e.message);
      }
    }
    // Notify watchers of the commented task's column.
    const tmeta = await this._taskColMeta(task_id);
    if (tmeta) await this._notifyColumnWatchers(tmeta, tmeta.status);
    this.output.data(row);
  }

  /**
   * Edit one's own comment. Returns empty (→ COMMENT_NOT_FOUND) if the caller
   * is not the author. Params: id (required), body (required), mention_uids.
   */
  async comment_update() {
    const id = this.input.need('id');
    const body = this.input.need('body');
    const data = await this.db.await_proc('task_comment_update', id, this.uid, body);
    const row = Array.isArray(data) ? data[0] : data;
    if (isEmpty(row)) return this.exception.user('COMMENT_NOT_FOUND');
    await this._broadcast('task.comment_update', row);
    await this._notifyCommentMentions(row.task_id, this.input.use('mention_uids', null));
    this.output.data(row);
  }

  /**
   * Delete one's own comment. Params: id (required), task_id (required — so the
   * broadcast can target the right task's feed).
   */
  async comment_delete() {
    const id = this.input.need('id');
    const task_id = this.input.need('task_id');
    const data = await this.db.await_proc('task_comment_delete', id, this.uid);
    const row = Array.isArray(data) ? data[0] : data;
    await this._broadcast('task.comment_delete', {
      id,
      task_id,
      affected: row && row.affected,
    });
    this.output.data({ id, task_id, affected: row && row.affected });
  }

  /**
   * Toggle the caller's emoji reaction on a comment (add if absent, remove if
   * present). Params: comment_id (required), emoji (required), task_id
   * (required — so the broadcast targets the right task's feed).
   */
  async comment_react() {
    const comment_id = this.input.need('comment_id');
    const emoji = this.input.need('emoji');
    const task_id = this.input.need('task_id');
    const data = await this.db.await_proc('task_comment_react', comment_id, this.uid, emoji);
    const row = Array.isArray(data) ? data[0] : data;
    await this._broadcast('task.comment_react', {
      task_id,
      comment_id,
      emoji,
      count: row && row.count,
    });
    this.output.data(row);
  }

  /**
   * List the custom Kanban columns for a folder scope.
   * Params: nid (folder node id; null/absent = workspace root scope).
   * Built-in columns (todo/in_progress/to_review/complete) are implicit
   * client-side and never stored.
   */
  async column_list() {
    const nid = this.input.use('nid', null);
    const data = await this.db.await_run('CALL task_column_list(?)', [nid]);
    this.output.list(data);
  }

  /**
   * Create a custom Kanban column.
   * Params: name (required), theme (palette key, optional), nid (folder scope).
   * The new column's id becomes the task.status key for tasks placed in it.
   */
  async column_create() {
    const name = String(this.input.need('name')).trim().slice(0, 100);
    if (!name) return this.exception.user('INVALID_COLUMN_NAME');
    let theme = this.input.use('theme', 'default');
    if (!VALID_THEMES.includes(theme)) theme = 'default';
    const nid = this.input.use('nid', null);

    const id = await this.yp.await_func('uniqueId');
    const data = await this.db.await_run(
      'CALL task_column_create(?, ?, ?, ?)',
      [id, nid, name, theme]
    );
    // The DB layer swallows SQL errors (returns empty) — an empty result here
    // means the insert didn't happen, most likely because this hub DB has not
    // been migrated (task_column table / procs missing). Fail loudly instead
    // of acking success with no data.
    if (isEmpty(data)) {
      return this.exception.user('COLUMN_CREATE_FAILED');
    }
    await this._broadcast('task.column_create', data);
    this.output.data(data);
  }

  /**
   * Rename and/or re-theme a column.
   * Params: id (required); nid (folder scope, nullable); name / theme
   * (optional — omit to keep).
   *
   * Scoped: built-in ids are literal status keys stored once per folder, so
   * an unscoped update would rename that built-in on EVERY board in the
   * workspace. Each board's columns are independent.
   */
  async column_update() {
    const id = this.input.need(Attr.id);
    const nid = this.input.use('nid', null);
    let name = this.input.use('name', null);
    if (name != null) {
      name = String(name).trim().slice(0, 100);
      if (!name) return this.exception.user('INVALID_COLUMN_NAME');
    }
    let theme = this.input.use('theme', null);
    if (theme != null && !VALID_THEMES.includes(theme)) theme = 'default';

    const data = await this.db.await_run(
      'CALL task_column_update_v2(?, ?, ?, ?)',
      [id, nid, name, theme]
    );
    if (isEmpty(data)) {
      return this.exception.user('COLUMN_NOT_FOUND');
    }
    await this._broadcast('task.column_update', data);
    this.output.data(data);
  }

  /**
   * Delete a column. Its tasks are re-homed onto the first surviving column of
   * the SAME board by the proc (never lost); the response carries moved_tasks
   * so the client re-fetches its task list when non-zero.
   * Params: id (required); nid (folder scope, nullable).
   *
   * Scoped for the same reason as column_update: deleting a built-in without
   * the folder would remove it from every board in the workspace.
   */
  async column_delete() {
    const id = this.input.need(Attr.id);
    const nid = this.input.use('nid', null);
    const data = await this.db.await_proc('task_column_delete_v2', id, nid);
    const row = Array.isArray(data) ? data[0] : data;
    await this._broadcast('task.column_delete', {
      id,
      nid,
      affected: row && row.affected,
      moved_tasks: row && row.moved_tasks,
      moved_to: row && row.moved_to,
    });
    this.output.data(row);
  }

  /**
   * Persist a drag-reorder of the custom columns. `order` is the comma-separated
   * column ids in their new left-to-right order; the proc sets each column's
   * position to its index in that list (built-in columns are client-side only
   * and unaffected). Scoped to the folder node so one folder's reorder can't
   * touch another's rows. Returns the columns in their new order.
   */
  async column_reorder() {
    const order = String(this.input.need('order') || '').trim();
    if (!order) return this.exception.user('INVALID_COLUMN_ORDER');
    const nid = this.input.use('nid', null);
    const data = await this.db.await_run(
      'CALL task_column_reorder(?, ?)',
      [nid, order]
    );
    await this._broadcast('task.column_reorder', { nid, order });
    this.output.list(data);
  }

  // ── Column notification subscriptions (bell toggle) ──────────────
  // Per-user, per-column, per-folder watch. When on, the user is notified of
  // any task change in that column (see _notifyColumnWatchers).

  async column_watch_list() {
    const nid = this.input.use('nid', '0') || '0';
    const data = await this.db.await_proc('task_column_watch_list', this.uid, nid);
    this.output.list(toArray(data).map((r) => r.column_key));
  }

  async column_watch_set() {
    const nid = this.input.use('nid', '0') || '0';
    const column_key = this.input.need('column_key');
    await this.db.await_proc('task_column_watch_set', this.uid, nid, column_key);
    this.output.data({ nid, column_key, watching: 1 });
  }

  async column_watch_unset() {
    const nid = this.input.use('nid', '0') || '0';
    const column_key = this.input.need('column_key');
    await this.db.await_proc('task_column_watch_unset', this.uid, nid, column_key);
    this.output.data({ nid, column_key, watching: 0 });
  }
}

module.exports = __private_task;
