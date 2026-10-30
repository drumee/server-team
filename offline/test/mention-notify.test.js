#!/usr/bin/env node
//
// mention-notify.test.js — @-mention parsing (service/lib/mention-markers.js),
// the explicit push sender (service/lib/message-author.js senderIdentity), and
// the meeting-description mention notice (service/private/room.js
// _notify_mentions, sliced out of the real source).
//
//   node --test offline/test/mention-notify.test.js
//
// Zero-dependency: @drumee/server-essentials is stubbed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const sent = [];
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@drumee/server-essentials') {
    return {
      Attr: { id: 'id', fullname: 'fullname', email: 'email' },
      toArray: (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])),
      RedisStore: { sendData: async (payload, to) => { sent.push({ payload, to }); } },
    };
  }
  return realLoad.call(this, request, ...rest);
};
const { mentionedUserIds, newlyMentionedUserIds, MAX_MENTIONS } = require('../../service/lib/mention-markers');
const { senderIdentity } = require('../../service/lib/message-author');
const { toArray, RedisStore, Attr } = require('@drumee/server-essentials');
Module._load = realLoad;
const { isEmpty } = require('lodash');

const ME = 'me00000000000001';
const ANN = 'ann0000000000001';
const BOB = 'bob0000000000001';
const OUT = 'out0000000000001';
const HUB = 'hub0000000000001';

// ---------------------------------------------------------------- markers
test('mentionedUserIds: person markers only, unique, in order', () => {
  const text = `Hi [@Ann A](user:${ANN}) and [@Bob](user:${BOB}), see [@doc.pdf](mention:${HUB}:n1) — again [@Ann A](user:${ANN})`;
  assert.deepStrictEqual(mentionedUserIds(text), [ANN, BOB]);
});

test('mentionedUserIds: junk input and malformed ids', () => {
  assert.deepStrictEqual(mentionedUserIds(null), []);
  assert.deepStrictEqual(mentionedUserIds(''), []);
  assert.deepStrictEqual(mentionedUserIds({}), []);
  assert.deepStrictEqual(mentionedUserIds('[@x](user:a b)'), []);
  assert.deepStrictEqual(mentionedUserIds("[@x](user:a'b)"), []);
  assert.deepStrictEqual(mentionedUserIds('plain @Ann text'), []);
});

test('mentionedUserIds: bounded', () => {
  let text = '';
  for (let i = 0; i < MAX_MENTIONS + 20; i++) text += `[@u${i}](user:u${i}) `;
  assert.strictEqual(mentionedUserIds(text).length, MAX_MENTIONS);
});

test('mentionedUserIds: repeated calls are independent (global regex state)', () => {
  const t = `[@Ann](user:${ANN})`;
  assert.deepStrictEqual(mentionedUserIds(t), [ANN]);
  assert.deepStrictEqual(mentionedUserIds(t), [ANN]);
});

test('newlyMentionedUserIds: only people the edit adds', () => {
  const prev = `[@Ann](user:${ANN})`;
  const next = `[@Ann](user:${ANN}) [@Bob](user:${BOB})`;
  assert.deepStrictEqual(newlyMentionedUserIds(prev, next), [BOB]);
  assert.deepStrictEqual(newlyMentionedUserIds(next, prev), []);
  assert.deepStrictEqual(newlyMentionedUserIds(undefined, prev), [ANN]);
});

// ---------------------------------------------------------------- sender
function fakeUser({ firstname = 'Duy', lastname = 'Nguyen', fullname = '', email = 'd@x.io' } = {}) {
  const attrs = { firstname, fullname, email, profile: { lastname } };
  return { attributes: attrs, get: (k) => attrs[k] };
}

test('senderIdentity: names the caller', () => {
  assert.deepStrictEqual(senderIdentity(fakeUser(), ME), {
    uid: ME, id: ME, firstname: 'Duy', lastname: 'Nguyen', fullname: 'Duy Nguyen', email: 'd@x.io',
  });
});

test('senderIdentity: no user still carries the uid, never throws', () => {
  assert.deepStrictEqual(senderIdentity(null, ME), { uid: ME, id: ME });
});

// ---------------------------------------------------------------- room
const roomSrc = fs.readFileSync(path.join(__dirname, '../../service/private/room.js'), 'utf8');
function sliceMethod(name) {
  const start = roomSrc.indexOf(`  async ${name}(`);
  assert.ok(start > 0, `${name} not found`);
  const end = roomSrc.indexOf('\n  }\n', start);
  return roomSrc.slice(start + 2, end + 4);
}
// eslint-disable-next-line no-new-func
const CAN_READ = 0b0000010;
const Room = new Function(
  'toArray', 'isEmpty', 'RedisStore', 'Attr', 'workspaceMemberIds', 'senderIdentity', 'CAN_READ',
  `return class { ${sliceMethod('_notify_mentions')}\n  ${sliceMethod('_can_read_meeting')} }`,
);

// `access` maps uid -> privilege on the meeting node; absent = no row.
function fakeRoom({ members = [ME, ANN, BOB], sockets = null, noticeFails = false,
  access = { [ANN]: 3, [BOB]: 7 }, accessThrows = false } = {}) {
  const calls = { notices: [], warns: [], access: [] };
  const R = Room(toArray, isEmpty, RedisStore, Attr,
    async () => (members ? new Set(members) : null), senderIdentity, CAN_READ);
  const r = new R();
  Object.assign(r, {
    uid: ME,
    user: fakeUser(),
    db: {
      await_proc: async (name, uid, nid) => {
        assert.strictEqual(name, 'mfs_access_node');
        calls.access.push([uid, nid]);
        if (accessThrows) throw new Error('db');
        return access[uid] == null ? [] : [{ id: nid, privilege: access[uid] }];
      },
    },
    hub: { get: (k) => (k === 'id' ? HUB : null) },
    yp: {
      await_proc: async (name, uids) => {
        assert.strictEqual(name, 'user_sockets');
        return sockets || uids.map((u) => ({ uid: u, socket_id: `s-${u}` }));
      },
    },
    payload: (data, options) => ({ model: data, options }),
    warn: (...a) => calls.warns.push(a),
    _meeting_folder_name: async (pid) => (pid ? 'Design' : null),
    _meeting_notice: async (uids, kind, p) => {
      if (noticeFails) throw new Error('boom');
      calls.notices.push({ uids, kind, p });
    },
  });
  return { r, calls };
}

test('_notify_mentions: members only, self dropped, notice + push', async () => {
  sent.length = 0;
  const { r, calls } = fakeRoom();
  await r._notify_mentions([ME, ANN, OUT, BOB], { nid: 'm1', pid: 'p1', title: 'Sync', stime: 100 });
  assert.strictEqual(calls.notices.length, 1);
  assert.deepStrictEqual(calls.notices[0].uids, [ANN, BOB]);
  assert.strictEqual(calls.notices[0].kind, 'mention');
  assert.strictEqual(calls.notices[0].p.folder_name, 'Design');
  assert.strictEqual(sent.length, 1);
  const { payload, to } = sent[0];
  assert.deepStrictEqual(to.map((s) => s.uid), [ANN, BOB]);
  assert.strictEqual(payload.options.service, 'room.mention');
  assert.strictEqual(payload.options.sender.uid, ME);
  assert.strictEqual(payload.options.sender.fullname, 'Duy Nguyen');
  assert.deepStrictEqual(payload.model, {
    event: 'meeting_notice', meeting_kind: 'mention', hub_id: HUB,
    nid: 'm1', pid: 'p1', title: 'Sync', stime: 100, folder_name: 'Design',
  });
});

test('_notify_mentions: unknown membership notifies nobody', async () => {
  sent.length = 0;
  const { r, calls } = fakeRoom({ members: null });
  await r._notify_mentions([ANN], { nid: 'm1' });
  assert.strictEqual(calls.notices.length, 0);
  assert.strictEqual(sent.length, 0);
});

test('_notify_mentions: nothing to do for empty / self / outsiders', async () => {
  sent.length = 0;
  const { r, calls } = fakeRoom();
  await r._notify_mentions([], {});
  await r._notify_mentions([ME], {});
  await r._notify_mentions([OUT], {});
  assert.strictEqual(calls.notices.length, 0);
  assert.strictEqual(sent.length, 0);
});

test('_notify_mentions: no live socket ⇒ durable notice only', async () => {
  sent.length = 0;
  const { r, calls } = fakeRoom({ sockets: [] });
  await r._notify_mentions([ANN], { nid: 'm1', pid: null, title: 'T' });
  assert.strictEqual(calls.notices.length, 1);
  assert.strictEqual(calls.notices[0].p.folder_name, null);
  assert.strictEqual(sent.length, 0);
});

test('_notify_mentions: a member who cannot read the meeting is not told', async () => {
  sent.length = 0;
  // BOB has no access row; ANN has privilege 1 (anonymous only, no read bit).
  const { r, calls } = fakeRoom({ access: { [ANN]: 1 } });
  await r._notify_mentions([ANN, BOB], { nid: 'm1', pid: 'p1', title: 'Secret' });
  assert.deepStrictEqual(calls.access, [[ANN, 'm1'], [BOB, 'm1']]);
  assert.strictEqual(calls.notices.length, 0);
  assert.strictEqual(sent.length, 0);
});

test('_notify_mentions: an access lookup failure notifies nobody', async () => {
  sent.length = 0;
  const { r, calls } = fakeRoom({ accessThrows: true });
  await r._notify_mentions([ANN], { nid: 'm1' });
  assert.strictEqual(calls.notices.length, 0);
  assert.strictEqual(sent.length, 0);
});

test('_notify_mentions: never throws', async () => {
  const { r, calls } = fakeRoom({ noticeFails: true });
  await r._notify_mentions([ANN], { nid: 'm1' });
  assert.strictEqual(calls.warns.length, 1);
});

test('room.js wires mentions into book() and update()', () => {
  assert.match(roomSrc, /_notify_mentions\(mentionedUserIds\(message\)/);
  assert.match(roomSrc, /_notify_mentions\(newlyMentionedUserIds\(prevMessage, message\)/);
  assert.match(roomSrc, /const prevMessage = message;/);
});
