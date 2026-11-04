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

/**
 * Not finished yet, judged by the task's WORKSPACE column (task_list_range's
 * `status_is_done`), never by the status word, because a custom column can be
 * the done one. A board whose columns were never seeded answers NULL, and then
 * the built-in default applies: only 'complete' is done.
 */
function isOpenTask(row) {
  if (!row) return false;
  const done = row.status_is_done;
  if (done === null || done === undefined || done === "") {
    return String(row.status || "") !== "complete";
  }
  return Number(done) === 0;
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
 * How many of task_list_range's rows for ONE day are the caller's open tasks
 * due on that day.
 *
 * task_list_range(day, day) answers every top-level task whose start..due
 * span overlaps the day, but the Calendar draws a task in ONE cell, its
 * due_date (client helpers rowStart), so a task running 11-01..11-05 is not
 * on the 11-03 day view and is not counted here either. Overdue tasks and
 * tasks with no due date are not counted: the card is about today.
 * A workspace task counts only when it is assigned to the caller (the
 * Calendar's own rule); a personal task is the caller's by construction.
 * Finished tasks are drawn by the Calendar but are not "due", so not counted.
 */
function countDayTasks(rows, uid, personal, day) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (ymdOf(r.due_date) !== String(day || "")) continue;
    if (!personal && !isAssignedTo(r, uid)) continue;
    if (isOpenTask(r)) n += 1;
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

module.exports = { isAssignedTo, isOpenTask, countDayTasks, takesPartIn, ymdOf };
