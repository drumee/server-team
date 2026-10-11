const assert = require('assert');
const { addableDepartments, memberMayAssign } = require('../service/lib/dept-workspace');

const rows = [
  { department_id: 'mkt', privilege: 31 },
  { department_id: 'ops', privilege: 15 },
  { department_id: 'ops', privilege: 3 },
  { department_id: 'dsg', privilege: 7 },
  { department_id: 'hr', privilege: 3 },
  { department_id: null, privilege: 63 },
];
const addable = addableDepartments(rows);
assert.deepEqual([...addable].sort(), ['mkt', 'ops'], 'admin and edit count, chat and view do not');
assert.equal(addableDepartments(undefined).size, 0, 'no rows');
assert.deepEqual([...addableDepartments({ department_id: 'x', privilege: 31 })], ['x'], 'single row object');

const own = { owner_id: 'u1', department_id: null };
assert.equal(memberMayAssign(own, 'u1', 'mkt', addable), true, 'own ungrouped workspace into an editable department');
assert.equal(memberMayAssign(own, 'u1', 'ops', addable), true, 'edit is enough');
assert.equal(memberMayAssign(own, 'u1', 'dsg', addable), false, 'chat is not');
assert.equal(memberMayAssign(own, 'u1', 'hr', addable), false, 'view is not');
assert.equal(memberMayAssign(own, 'u1', '', addable), false, 'never out of a department');
assert.equal(memberMayAssign({ owner_id: 'u2', department_id: null }, 'u1', 'mkt', addable), false, 'not their workspace');
assert.equal(memberMayAssign({ owner_id: 'u1', department_id: 'ops' }, 'u1', 'mkt', addable), false, 'already in a department');
assert.equal(memberMayAssign(null, 'u1', 'mkt', addable), false, 'no such workspace');

console.log('dept-workspace: ok');
