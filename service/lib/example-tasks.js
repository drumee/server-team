/**
 * The two example tasks a new workspace opens with — Figma Board 922:159854:
 * "Task 1" and "Task 2" in To Do, medium priority (task.priority cannot be
 * unset), due one week out, no assignee, filed at the workspace root.
 *
 * Built here and run by desk.create_hub (service/private/desk.js
 * _seedExampleTasks) straight against the new hub's `task` table — no stored
 * procedure, so nothing has to be patched into hub DBs or the factory's hub
 * template for it to work on every workspace created after a deploy.
 *
 * ONE statement, `INSERT … SELECT … WHERE NOT EXISTS`: both rows or none, and
 * a second run on the same workspace inserts nothing.
 *
 * Only columns every task table generation has, plus `rank` when present.
 * reporter_uid is left NULL on purpose: NULL means "the creator" in the task
 * contract (every reader COALESCEs it), and leaving it out lets a hub whose
 * table predates alter_task_add_reporter seed too.
 */
const TITLES = ["Task 1", "Task 2"];
const DESCRIPTION = "Enter the description for task";
const REQUIRED_COLUMNS = [
  "id", "title", "description", "status", "priority", "due_date",
  "created_by", "nid", "ctime", "mtime",
];
// yp.get_db_name values are plain identifiers; anything else is refused
// rather than interpolated.
const SAFE_DB = /^[A-Za-z0-9_]+$/;

/**
 * @param {string}   hubDb   the new hub's database
 * @param {string[]} columns the hub's task table columns
 * @param {string[]} ids     two fresh task ids (yp.uniqueId)
 * @param {string}   uid     the creator
 * @param {string}   nid     the hub root node (root-level tasks' scope)
 * @returns {{sql: string, params: string[]}|null} null when it cannot be built safely
 */
function buildSeedInsert(hubDb, columns, ids, uid, nid) {
  if (!SAFE_DB.test(String(hubDb || ""))) return null;
  if (!Array.isArray(ids) || ids.length !== TITLES.length) return null;
  const has = new Set(columns || []);
  if (!REQUIRED_COLUMNS.every((c) => has.has(c))) return null;
  const withRank = has.has("rank");
  const cols = [...REQUIRED_COLUMNS, ...(withRank ? ["rank"] : [])];
  // Same order as REQUIRED_COLUMNS: id, title, description, status, priority,
  // due_date, created_by, nid, ctime, mtime[, rank]
  // A derived table needs unique column names, so the first row aliases
  // every value (two UNIX_TIMESTAMP() would otherwise clash: ER_DUP_FIELDNAME).
  const values = (i) => [
    "?", "?", "?", "'todo'", "'medium'", "CURDATE() + INTERVAL 7 DAY", "?", "?",
    "UNIX_TIMESTAMP()", "UNIX_TIMESTAMP()", ...(withRank ? [String(i + 1)] : []),
  ];
  const row = (i) =>
    "SELECT " + values(i).map((v, k) => (i === 0 ? `${v} AS ${cols[k]}` : v)).join(", ");
  const table = `\`${hubDb}\`.task`;
  const sql =
    `INSERT INTO ${table} (${cols.join(", ")}) ` +
    `SELECT * FROM (${TITLES.map((_, i) => row(i)).join(" UNION ALL ")}) s ` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${table})`;
  const params = TITLES.flatMap((title, i) => [ids[i], title, DESCRIPTION, uid, nid]);
  return { sql, params };
}

module.exports = { buildSeedInsert, REQUIRED_COLUMNS, TITLES, DESCRIPTION };
