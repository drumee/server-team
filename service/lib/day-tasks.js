/**
 * Which tasks and meetings belong to the caller's day. Shared by the Personal
 * Calendar (calendar.list) and the Daily Reminder card (activity.daily_digest)
 * so the number on the card is the number of items the Calendar's day view
 * draws when the card is clicked (Lexis, 2026-11-03). PURE: no I/O.
 */

/**
 * Is `uid` one of the task's assignees? task_list_range answers them as
 * `assignee_uids`, a GROUP_CONCAT of uids (NULL when the task has none).
 */
function isAssignedTo(row, uid) {
  if (!row || !row.assignee_uids) return false;
  return String(row.assignee_uids).split(",").includes(String(uid));
}

// The built-in columns whose tasks are still to be worked on, by their
// literal ids (task.status holds the id): a board that renames them keeps
// them. 'to_review' and 'complete' are not on the list.
const DUE_BUILTIN_IDS = ["todo", "in_progress"];
// "Reopen" is no built-in: boards add it as a CUSTOM column (random id), so
// it can only be recognised by its name, compared without case, spaces or
// hyphens ("Reopen", "re-open", "Reopened").
const DUE_COLUMN_NAMES = ["reopen", "reopened"];

/**
 * Does the task sit in a column the Daily Reminder counts as due (Lexis via
 * Duy, 2026-11-03): To do, In progress, Reopen. Any other column (To review /
 * In Test, In Preview, Released, Complete, other custom ones) is not counted.
 * A column flagged done (`status_is_done`) is never counted, whatever its
 * name. `status_label` is the column's name from task_list_range, NULL on a
 * board whose columns were never seeded, where only the built-in id is known.
 */
function isDueColumn(row) {
  if (!row) return false;
  if (Number(row.status_is_done) === 1) return false;
  const id = String(row.status || "");
  if (DUE_BUILTIN_IDS.includes(id)) return true;
  const name = String(row.status_label || "").toLowerCase().replace(/[\s_-]+/g, "");
  return DUE_COLUMN_NAMES.includes(name);
}

/**
 * A DATE column as 'YYYY-MM-DD', whichever shape the driver hands back: a
 * string, or a Date the connector built at LOCAL midnight (so the local
 * getters, not toISOString, give back the stored day). '' when unreadable.
 */
function ymdOf(v) {
  if (!v) return "";
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}

/**
 * How many of task_list_range's rows for ONE day are the caller's tasks due
 * on that day and still to be worked on.
 *
 * task_list_range(day, day) answers every top-level task whose start..due
 * span overlaps the day, but the Calendar draws a task in ONE cell, its
 * due_date (client helpers rowStart), so a task running 11-01..11-05 is not
 * on the 11-03 day view and is not counted here either. Overdue tasks and
 * tasks with no due date are not counted: the card is about today.
 * A workspace task counts only when it is assigned to the caller (the
 * Calendar's own rule); a personal task is the caller's by construction.
 * Only tasks in a due column count (isDueColumn): the day view draws every
 * column, so a task In Test or Released today is drawn but not counted.
 */
function countDayTasks(rows, uid, personal, day) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (ymdOf(r.due_date) !== String(day || "")) continue;
    if (!personal && !isAssignedTo(r, uid)) continue;
    if (isDueColumn(r)) n += 1;
  }
  return n;
}

/**
 * Does the caller organize or attend this meeting? `content` is the meeting's
 * parsed metadata.content; attendees are uids or `{ uid }` objects. The
 * Calendar lists meetings by the same rule (meeting_schedule_range).
 */
function takesPartIn(content, uid) {
  if (!content || !uid) return false;
  const me = String(uid);
  if (content.created_by && String(content.created_by) === me) return true;
  const list = Array.isArray(content.attendees) ? content.attendees : [];
  return list.some((a) => a && String(a.uid || a) === me);
}

module.exports = { isAssignedTo, isDueColumn, countDayTasks, takesPartIn, ymdOf };
