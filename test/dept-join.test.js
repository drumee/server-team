const assert = require('assert');
const { joinDepartmentOf } = require('../service/lib/dept-join');
function yp({ hub, primary = false, member = null }) {
  const calls = [];
  return {
    calls,
    await_query: async (sql) => {
      if (/FROM hub/.test(sql)) return hub ? [hub] : [];
      if (/FROM privilege/.test(sql)) return primary ? [{ yes: 1 }] : [];
      return [];
    },
    await_proc: async (name, ...a) => { calls.push([name, ...a]); return name === 'org_membership_get' ? member : null; },
  };
}
(async () => {
  let y = yp({ hub: { domain_id: 35, department_id: 'd1' } });
  assert.equal(await joinDepartmentOf(y, 'h1', 'u1', 'by'), true);
  assert.deepEqual(y.calls.map((c) => c[0]), ['org_membership_get', 'org_membership_set', 'department_member_add']);
  assert.deepEqual(y.calls[2], ['department_member_add', 35, 'd1', 'u1', 'by']);
  y = yp({ hub: { domain_id: 35, department_id: 'd1' }, primary: true });
  await joinDepartmentOf(y, 'h1', 'u1', 'by');
  assert.deepEqual(y.calls.map((c) => c[0]), ['department_member_add'], 'primary member: no secondary membership');
  y = yp({ hub: { domain_id: 35, department_id: 'd1' }, member: { privilege: 1 } });
  await joinDepartmentOf(y, 'h1', 'u1', null);
  assert.deepEqual(y.calls.map((c) => c[0]), ['org_membership_get', 'department_member_add'], 'already secondary');
  y = yp({ hub: { domain_id: 35, department_id: null } });
  assert.equal(await joinDepartmentOf(y, 'h1', 'u1', 'by'), false);
  assert.equal(y.calls.length, 0, 'no department: nothing');
  y = yp({ hub: { domain_id: 1, department_id: 'd1' } });
  assert.equal(await joinDepartmentOf(y, 'h1', 'u1', 'by'), false, 'personal domain: nothing');
  const bad = { await_query: async () => { throw new Error('db'); } };
  assert.equal(await joinDepartmentOf(bad, 'h1', 'u1', 'by'), false, 'never throws');
  console.log('dept-join: all 6 cases pass');
})().catch((e) => { console.error(e); process.exit(1); });
