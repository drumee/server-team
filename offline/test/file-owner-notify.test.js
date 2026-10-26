#!/usr/bin/env node
//
// file-owner-notify.test.js — "<actor> edited / commented on <file>" for the
// file's owner (service/lib/file-owner-notify.js) and the feed wiring that
// makes those rows render, count and land in Files (service/private/activity.js).
//
//   node --test offline/test/file-owner-notify.test.js
//
// Zero-dependency: @drumee/server-essentials is stubbed, the yp connection is
// a fake that records every call, and the activity.js pieces are sliced out of
// the real source rather than copied, so a change there is what gets tested.

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
      toArray: (v) => (v == null ? [] : (Array.isArray(v) ? v : [v])),
      RedisStore: { sendData: async (payload, to) => { sent.push({ payload, to }); } },
    };
  }
  return realLoad.call(this, request, ...rest);
};
const lib = require('../../service/lib/file-owner-notify');
Module._load = realLoad;

const OWNER = 'owner00000000001';
const ACTOR = 'actor00000000001';
const HUB = 'hub0000000000001';
const NID = 'nid0000000000001';

function fakeSvc({ owner = OWNER, node = {}, failLog = false } = {}) {
  const calls = [];
  const warns = [];
  const yp = {
    await_func: async (name, ...args) => { calls.push([name, ...args]); return 'hubdb_1'; },
    await_query: async (sql, ...args) => { calls.push(['query', sql, ...args]); return owner ? [{ owner_id: owner }] : []; },
    await_proc: async (name, ...args) => {
      calls.push([name, ...args]);
      if (name === 'hubdb_1.mfs_access_node') {
        return {
          nid: NID, status: 'active', filetype: 'document', privilege: 3,
          filename: 'Report', ext: 'docx', parent_id: 'pid0000000000001', parent_path: '/Team/Q3/',
          ...node,
        };
      }
      if (name === 'contact_log_activity' && failLog) throw new Error('boom');
      if (name === 'user_sockets') return [{ socket_id: 's1' }];
      return [];
    },
  };
  return {
    yp, calls, warns,
    warn: (...a) => warns.push(a),
    payload: (data, opt) => ({ data, ...opt }),
  };
}

const logged = (svc) => svc.calls.filter((c) => c[0] === 'contact_log_activity');

test('edit: writes one file_edited row for the owner with the file fields, and pushes', async () => {
  sent.length = 0;
  const svc = fakeSvc();
  const ok = await lib.notifyFileOwner(svc, { event: 'file_edited', hub_id: HUB, nid: NID, actor: ACTOR, source: 'editor' });
  assert.strictEqual(ok, true);
  const [row] = logged(svc);
  assert.deepStrictEqual(row.slice(0, 4), ['contact_log_activity', ACTOR, OWNER, 'file_edited']);
  assert.deepStrictEqual(row[4], {
    hub_id: HUB, nid: NID, pid: 'pid0000000000001', filename: 'Report', ext: 'docx',
    filetype: 'document', folder_name: 'Q3', source: 'editor',
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].payload.service, 'activity.file_owner');
});

test('comment: carries the excerpt (mentions flattened) and the message id', async () => {
  const svc = fakeSvc();
  await lib.notifyFileOwner(svc, {
    event: 'file_commented', hub_id: HUB, nid: NID, actor: ACTOR,
    comment: 'please check  [@Ann B](mention:abc)\nthanks', message_id: 'msg_1', source: 'thread',
  });
  const data = logged(svc)[0][4];
  assert.strictEqual(data.comment, 'please check @Ann B thanks');
  assert.strictEqual(data.message_id, 'msg_1');
});

test('the owner editing their own file is not notified', async () => {
  const svc = fakeSvc({ owner: ACTOR });
  assert.strictEqual(await lib.notifyFileOwner(svc, { event: 'file_edited', hub_id: HUB, nid: NID, actor: ACTOR }), false);
  assert.strictEqual(logged(svc).length, 0);
});

test('an owner who can no longer read the file is not notified', async () => {
  for (const node of [{ privilege: 0 }, { status: 'deleted' }, { filetype: 'folder' }]) {
    const svc = fakeSvc({ node });
    assert.strictEqual(await lib.notifyFileOwner(svc, { event: 'file_edited', hub_id: HUB, nid: NID, actor: ACTOR }), false, JSON.stringify(node));
    assert.strictEqual(logged(svc).length, 0);
  }
});

test('unknown event, bad ids and a missing owner write nothing', async () => {
  const cases = [
    { event: 'media.new', hub_id: HUB, nid: NID, actor: ACTOR },
    { event: 'file_edited', hub_id: "x' OR 1", nid: NID, actor: ACTOR },
    { event: 'file_edited', hub_id: HUB, nid: NID, actor: '' },
    // an anonymous public-link visitor
    { event: 'file_edited', hub_id: HUB, nid: NID, actor: 'ffffffffffffffff' },
  ];
  for (const c of cases) {
    const svc = fakeSvc();
    assert.strictEqual(await lib.notifyFileOwner(svc, c), false);
    assert.strictEqual(svc.calls.length, 0);
  }
  const svc = fakeSvc({ owner: null });
  assert.strictEqual(await lib.notifyFileOwner(svc, { event: 'file_edited', hub_id: HUB, nid: NID, actor: ACTOR }), false);
  assert.strictEqual(logged(svc).length, 0);
});

test('never throws: a DB failure is logged and swallowed', async () => {
  const svc = fakeSvc({ failLog: true });
  assert.strictEqual(await lib.notifyFileOwner(svc, { event: 'file_edited', hub_id: HUB, nid: NID, actor: ACTOR }), false);
  assert.strictEqual(svc.warns.length, 1);
});

test('excerpt is capped', () => {
  assert.strictEqual(lib.excerpt('x'.repeat(500)).length, 200);
  assert.strictEqual(lib.folderNameOf('/'), null);
});

// ---------------------------------------------------------------------------
// activity.js wiring, sliced from the real source.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'service', 'private', 'activity.js'), 'utf8');

function sliceFunction(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} not found in activity.js`);
  let depth = 0;
  for (let i = SRC.indexOf('{', SRC.indexOf(')', start)); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

test('flattenFileOwnerActivity stamps category, author and file fields from data', () => {
  const flatten = new Function(`${sliceFunction('flattenFileOwnerActivity')}; return flattenFileOwnerActivity;`)();
  const rows = flatten([
    { id: 9, uid: ACTOR, event: 'file_commented', event_type: 'contact', hub_id: null,
      data: JSON.stringify({ hub_id: HUB, nid: NID, pid: 'p', filename: 'Report', ext: 'docx', comment: 'hi', message_id: 'm' }) },
    { id: 10, uid: ACTOR, event: 'task_assigned', data: '{}' },
  ]);
  assert.strictEqual(rows[0].category, 'file_commented');
  assert.strictEqual(rows[0].author_id, ACTOR);
  assert.strictEqual(rows[0].hub_id, HUB);
  assert.strictEqual(rows[0].nid, NID);
  assert.strictEqual(rows[0].comment, 'hi');
  assert.strictEqual(rows[0].message_id, 'm');
  assert.strictEqual(rows[1].category, undefined, 'other events untouched');
});

test('both events land in Files, are counted, and are cleared by the Files tab', () => {
  assert.match(SRC, /file_edited: BUCKET\.files,/);
  assert.match(SRC, /file_commented: BUCKET\.files,/);
  assert.match(SRC, /contact_file_edited_unread: 'file_edited',/);
  assert.match(SRC, /contact_file_commented_unread: 'file_commented',/);
  const procs = SRC.slice(SRC.indexOf('const CONTACT_UNREAD_PROCS'), SRC.indexOf('const CONTACT_UNREAD_EVENTS'));
  assert.match(procs, /'contact_file_edited_unread'/);
  assert.match(procs, /'contact_file_commented_unread'/);
  const clear = SRC.slice(SRC.indexOf('const CONTACT_CLEAR'), SRC.indexOf('if (bucket && lookup(CONTACT_CLEAR'));
  assert.match(clear, /\[BUCKET\.files\]: \[\s*'contact_file_edited_unread',\s*'contact_file_commented_unread',/);
});

// ── notifyEditorSave / memberByDisplayName (Casual Docs / Sheets saves) ─────
function editorSvc({ me = { firstname: 'Duy', lastname: 'Nguyen' }, members = [] } = {}) {
  const svc = fakeSvc();
  svc.uid = ACTOR;
  const base = svc.yp.await_proc;
  svc.yp.await_proc = async (name, ...args) => (name === 'get_user' ? [me] : base(name, ...args));
  const baseQuery = svc.yp.await_query;
  svc.yp.await_query = async (sql, ...args) => (/FROM `hubdb_1`.permission/.test(sql) ? members : baseQuery(sql, ...args));
  return svc;
}

test("an anchor-only comment (no author) is the saver's, and the saver gets no edited", async () => {
  const svc = editorSvc();
  await lib.notifyEditorSave(svc, { hub_id: HUB, nid: NID, comments: [{ author: '', text: '' }] });
  assert.deepStrictEqual(logged(svc).map((r) => [r[1], r[3]]), [[ACTOR, 'file_commented']]);
});

test('a comment signed by the saver: commented only; signed by another member: both', async () => {
  let svc = editorSvc();
  await lib.notifyEditorSave(svc, { hub_id: HUB, nid: NID, comments: [{ author: 'duy nguyen ', text: 'fix B2' }] });
  assert.deepStrictEqual(logged(svc).map((r) => [r[1], r[3], r[4].comment]), [[ACTOR, 'file_commented', 'fix B2']]);

  const BOB = 'bob0000000000001';
  svc = editorSvc({ members: [{ id: BOB, firstname: 'Bob', lastname: 'Tran' }, { id: ACTOR, firstname: 'Duy', lastname: 'Nguyen' }] });
  await lib.notifyEditorSave(svc, { hub_id: HUB, nid: NID, comments: [{ author: 'Bob Tran', text: 'ok' }] });
  assert.deepStrictEqual(logged(svc).map((r) => [r[1], r[3]]), [[BOB, 'file_commented'], [ACTOR, 'file_edited']]);
});

test('an author nobody (or two members) signs as is never guessed', async () => {
  const svc = editorSvc({ members: [{ id: 'x1', firstname: 'Sam' }, { id: 'x2', firstname: 'Sam' }] });
  await lib.notifyEditorSave(svc, { hub_id: HUB, nid: NID, comments: [{ author: 'Sam', text: 'a' }, { author: 'Nobody', text: 'b' }] });
  assert.deepStrictEqual(logged(svc).map((r) => [r[1], r[3]]), [[ACTOR, 'file_edited']]);
});

test('display name = "First Last", else username, else email', () => {
  assert.strictEqual(lib.displayName({ firstname: 'Ann', lastname: 'Lee', username: 'ann' }), 'Ann Lee');
  assert.strictEqual(lib.displayName({ username: 'ann', email: 'a@x' }), 'ann');
  assert.strictEqual(lib.displayName({ email: 'a@x' }), 'a@x');
});

test('focus is stored with a comment notification, whitelisted and short', async () => {
  const svc = fakeSvc();
  await lib.notifyFileOwner(svc, {
    event: 'file_commented', hub_id: HUB, nid: NID, actor: ACTOR, comment: 'hi',
    focus: { comment_id: 'c1', sub_unit_id: 's9', ref: 'B2', evil: 'x', tab_id: 'y'.repeat(500) },
  });
  const data = logged(svc)[0][4];
  assert.deepStrictEqual(Object.keys(data.focus).sort(), ['comment_id', 'ref', 'sub_unit_id', 'tab_id']);
  assert.strictEqual(data.focus.tab_id.length, 64);
  assert.strictEqual(lib.focusOf(null), null);
  assert.strictEqual(lib.focusOf({}), null);
});
