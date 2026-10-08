const assert = require('assert');
const AO = require('../service/lib/active-org');
class M { constructor(o){this.o={...o};} get(k){return this.o[k];} set(k,v){ if(typeof k==='object') Object.assign(this.o,k); else this.o[k]=v; } }
function session({ hostDom, own, signed=1, member=null, guest=false, fail=false }) {
  const calls = [];
  return { calls,
    user: new M({ id: 'u1', signed_in: signed, domain_id: own, db_name: 'd_x' }),
    hub: new M({ org_id: hostDom }),
    yp: {
      await_proc: async (name, ...a) => { calls.push(name); if (fail) throw new Error('db'); return member; },
      await_query: async () => { calls.push('q'); return guest ? [{ yes: 1 }] : []; },
    } };
}
(async () => {
  let s = session({ hostDom: 73, own: 73 }); await AO.apply(s);
  assert.equal(s.user.get('domain_id'), 73); assert.equal(s.calls.length, 0, 'own org: no lookup');
  s = session({ hostDom: 1, own: 73 }); await AO.apply(s); assert.equal(s.calls.length, 0, 'main domain: no lookup');
  s = session({ hostDom: 73, own: 35, signed: 0 }); await AO.apply(s); assert.equal(s.user.get('domain_id'), 35, 'signed out untouched');
  s = session({ hostDom: 73, own: 35, member: { privilege: 1 } }); await AO.apply(s);
  assert.equal(s.user.get('domain_id'), 73); assert.equal(s.user.get('active_org').role, 'member'); assert.equal(s.user.get('home_domain_id'), 35);
  AO.forget('u1');
  s = session({ hostDom: 74, own: 35, guest: true }); await AO.apply(s);
  assert.equal(s.user.get('domain_id'), 74); assert.equal(s.user.get('active_org').privilege, 0); assert.equal(s.user.get('active_org').role, 'guest');
  AO.forget('u1');
  s = session({ hostDom: 75, own: 35 }); await AO.apply(s); assert.equal(s.user.get('domain_id'), 35, 'stranger untouched');
  AO.forget('u1');
  s = session({ hostDom: 76, own: 35, fail: true }); await AO.apply(s); assert.equal(s.user.get('domain_id'), 35, 'db error untouched');
  s = session({ hostDom: 73, own: 35, member: { privilege: 1 } }); await AO.apply(s); // cached from earlier? forgot -> lookup
  console.log('active-org: all 8 cases pass');
})().catch((e) => { console.error(e); process.exit(1); });
