const assert = require('node:assert/strict');
const test = require('node:test');

// The contact_*_unread procedures stop at 50 rows per event. These tests pin
// the uncapped paths (contact_unread_rows / _count / _ids / _mark_read) and
// that every caller falls back to the old procedures while they are absent.

const Activity = require('../service/private/activity');

const EVENTS = {
  contact_task_assigned_unread: 'task_assigned',
  contact_task_mention_unread: 'task_mention',
  contact_task_column_change_unread: 'task_column_change',
  contact_storage_alert_unread: 'storage_alert',
  contact_reward_expiry_unread: 'reward_expiry_warning',
  contact_meeting_notice_unread: 'meeting_notice',
  contact_invite_accepted_unread: 'invite_accepted',
};

const contactRow = (id, event, extra = {}) => ({
  id, event, event_type: 'contact', timestamp: 1000 - id, data: '{}', is_read: 0, ...extra,
});

function base(overrides = {}) {
  const activity = Object.create(Activity.prototype);
  activity.uid = 'me';
  activity.debug = () => undefined;
  activity.warn = () => undefined;
  return Object.assign(activity, overrides);
}

test('_contactUnreadRows pages every event through contact_unread_rows', async () => {
  const calls = [];
  const activity = base({
    async _optionalYpProcResult(proc, uid, event, offset, limit) {
      calls.push([proc, uid, event, offset, limit]);
      return {ok: true, rows: event === 'task_mention' ? [contactRow(offset + 1, event)] : []};
    },
    async _optionalYpProc() { throw new Error('old procedures must not run'); },
  });

  const page1 = await activity._contactUnreadRows(1);
  assert.deepEqual(page1.map((r) => r.id), [1]);
  assert.deepEqual(calls.map((c) => c[2]), Object.values(EVENTS));
  assert.ok(calls.every(([proc, uid, , offset, limit]) => (
    proc === 'contact_unread_rows' && uid === 'me' && offset === 0 && limit === 50
  )));

  calls.length = 0;
  const page3 = await activity._contactUnreadRows(3);
  assert.deepEqual(page3.map((r) => r.id), [101]);
  assert.ok(calls.every((c) => c[3] === 100));
});

test('_contactUnreadRows falls back to the old procedures while contact_unread_rows is absent', async () => {
  const old = [];
  const activity = base({
    async _optionalYpProcResult() { return {ok: false, rows: []}; },
    async _optionalYpProc(proc) {
      old.push(proc);
      return proc === 'contact_task_mention_unread' ? [contactRow(7, 'task_mention'), null] : [];
    },
  });

  const page1 = await activity._contactUnreadRows(1);
  assert.deepEqual(page1.map((r) => r.id), [7]);
  assert.deepEqual(old, Object.keys(EVENTS));

  // Later pages: exactly what the feed returned before (nothing).
  old.length = 0;
  assert.deepEqual(await activity._contactUnreadRows(2), []);
  assert.deepEqual(old, []);
});

function countsContext(countAnswer) {
  let sent;
  const fifty = (event) => Array.from({length: 50}, (_, i) => contactRow(i + 1, event));
  const activity = base({
    input: {use: () => undefined},
    output: {data: (d) => { sent = d; return d; }},
    yp: {await_proc: async () => []},
    async _optionalYpProc(proc) {
      if (proc === 'contact_task_mention_unread') return fifty('task_mention');
      if (proc === 'contact_task_assigned_unread') return fifty('task_assigned');
      if (proc === 'contact_meeting_notice_unread') return [contactRow(1923, 'meeting_notice')];
      return [];
    },
    async _optionalYpProcResult(proc) {
      assert.equal(proc, 'contact_unread_count');
      return countAnswer;
    },
    async _notificationRollups() { return []; },
    async _callUserProc(proc) {
      if (proc === 'mfs_get_unread_count') return [{unread_count: 4}];
      return [];
    },
    async _newFilesByHub() { return []; },
  });
  return {activity, sent: () => sent};
}

test('unread_counts uses the real number of unread task rows', async () => {
  const {activity, sent} = countsContext({ok: true, rows: [
    {event: 'task_mention', cnt: 317},
    {event: 'task_assigned', cnt: 57},
    {event: 'meeting_notice', cnt: 1},
  ]});
  await activity.unread_counts();
  const out = sent();
  assert.equal(out.task, 374);
  assert.equal(out.meeting, 1); // listed already: nothing added
  assert.equal(out.files, 4);
  assert.equal(out.all, 379);
});

test('unread_counts is unchanged while contact_unread_count is absent', async () => {
  const {activity, sent} = countsContext({ok: false, rows: []});
  await activity.unread_counts();
  assert.equal(sent().task, 100);
  assert.equal(sent().all, 105);
});

test('Unread OFF keeps a contact row past the 50th unread when contact_unread_ids counts it', async () => {
  const asked = [];
  const activity = base({
    async _optionalYpProcResult(proc, uid, ids) {
      asked.push([proc, uid, ids]);
      return {ok: true, rows: [{id: 900}]};
    },
    async _optionalYpProc() { throw new Error('capped procedures must not decide'); },
    async _callUserProc(proc) {
      if (proc === 'notification_hub_invites') return [];
      if (proc === 'notification_contact_refused') return [];
      throw new Error(`unexpected procedure: ${proc}`);
    },
  });
  const b = {feed_page_source: 'base', event_type: 'contact', is_read: 0};
  const rows = [
    {...b, id: 900, event: 'task_mention', uid: 'E'},
    {...b, id: 901, event: 'invite_sent', uid: 'F'},
  ];
  await activity._alignContactReadState(rows, []);
  assert.deepEqual(asked, [['contact_unread_ids', 'me', '[900,901]']]);
  assert.equal(rows[0].is_read, 0);
  assert.equal(rows[1].is_read, 1);
});

test('Mark as all read on Task clears every unread task row in one call per event', async () => {
  const yp = [];
  const marked = [];
  const context = {
    uid: 'me',
    input: {get: () => 0, use: (k) => (k === 'bucket' ? 'task' : undefined)},
    debug: () => undefined,
    warn: () => undefined,
    output: {data: (d) => d},
    yp: {await_proc: async (...args) => { yp.push(args); return [{status: 'ok'}]; }},
    async _optionalYpProc() { throw new Error('the capped loop must not run'); },
    async _optionalYpProcResult(proc, ...args) {
      yp.push([proc, ...args]);
      return {ok: true, rows: [{status: 'ok', marked: 3}]};
    },
    async _markContactRead(id) { marked.push(id); },
    async _callUserProc(proc) {
      if (proc === 'notification_center_next') return [];
      return [{status: 'ok'}];
    },
  };

  const result = await Activity.prototype.mark_all_read.call(context);
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    yp.filter(([p]) => p === 'contact_unread_mark_read'),
    [
      ['contact_unread_mark_read', 'me', 'task_assigned'],
      ['contact_unread_mark_read', 'me', 'task_mention'],
      ['contact_unread_mark_read', 'me', 'task_column_change'],
    ],
  );
  assert.deepEqual(marked, []);
});

// get_feed with every enrichment stubbed out: only the merge / bucket / drop
// logic under test runs.
// Each context gets its own user database name: the missing-routine
// cooldown is keyed per database and lives for the whole process.
let dbSeq = 0;
function feedContext({input, baseRows, rollups = [], contactRows = {}, bucketRows = null}) {
  let listed;
  const calls = [];
  const dbName = `db_feed_${++dbSeq}`;
  const activity = base({
    input: {use: (k) => input[k]},
    user: {get: () => dbName},
    output: {list: (rows) => { listed = rows; return rows; }},
    yp: {await_proc: async () => []},
    async _callUserProc(proc, ...args) {
      calls.push([proc, ...args]);
      if (proc === 'activity_get_feed_all' || proc === 'mfs_get_activity_feed') {
        return baseRows.map((r) => ({...r}));
      }
      // activity_get_feed_bucket not deployed unless the test gives its rows.
      if (proc === 'activity_get_feed_bucket') {
        return bucketRows ? bucketRows.map((r) => ({...r})) : undefined;
      }
      return [];
    },
    async _optionalYpProcResult(proc, uid, event, offset) {
      assert.equal(proc, 'contact_unread_rows');
      return {ok: true, rows: (contactRows[event] || []).slice(offset, offset + 50).map((r) => ({...r}))};
    },
    async _optionalYpProc() { return []; },
    async _resolveOpeners() { return new Map(); },
    async _notificationRollups() { return rollups.map((r) => ({...r})); },
    async _storedRollups() { return []; },
    async _retireRollups() {},
    async _stampFolderNames() {},
    async _stampTaskFolderNames() {},
    async _stampHubInvites() {},
    async _stampInviteStatus() {},
    async _stampChatMentions() {},
    async _stampMeetingRollups(rows) { return rows; },
    async _alignContactReadState() {},
    async _dropDeleted(rows) { return rows; },
    async _decorateBookmarks(rows) { return rows; },
  });
  return {activity, listed: () => listed, calls};
}

const task = (id) => ({id, event: 'task_mention', event_type: 'contact', timestamp: 900 + id, is_read: 0, data: '{}'});

test('Unread OFF, Meeting tab: an unread notice deep in the feed is on page 1, its raw copy never repeats', async () => {
  const notice = contactRow(1923, 'meeting_notice', {timestamp: 5});
  const contactRows = {meeting_notice: [notice]};

  // Page 1 of the base feed holds only task rows.
  const p1 = feedContext({
    input: {page: 1, unread_only: 0, bucket: 'meeting'},
    baseRows: [task(1), task(2)],
    contactRows,
  });
  await p1.activity.get_feed();
  assert.deepEqual(p1.listed().map((r) => r.id), [1923]);

  // A later page carries the raw copy (unread) and an older read notice.
  const p4 = feedContext({
    input: {page: 4, unread_only: 0, bucket: 'meeting'},
    baseRows: [
      {...notice, is_read: 0},
      {...contactRow(1800, 'meeting_notice', {timestamp: 4}), is_read: 1},
      task(3),
    ],
    contactRows,
  });
  await p4.activity.get_feed();
  assert.deepEqual(p4.listed().map((r) => r.id), [1800]);
});

test('Unread OFF, Other tab: invitation rollups stand for their raw rows', async () => {
  const p1 = feedContext({
    input: {page: 1, unread_only: 0, bucket: 'other'},
    baseRows: [
      task(1),
      {id: 1060, event: 'hub_invite_received', event_type: 'contact', timestamp: 3, is_read: 0, data: '{}'},
      {id: 1050, event: 'invite_sent', event_type: 'contact', timestamp: 2, is_read: 1, data: '{}'},
    ],
    rollups: [{category: 'hub_invite', key_id: '1060', hub_id: 'h1', ctime: 3}],
  });
  await p1.activity.get_feed();
  const out = p1.listed();
  assert.deepEqual(out.map((r) => r.category || r.event), ['hub_invite', 'invite_sent']);
});

test('Unread OFF on Task / All is untouched by the Meeting / Other merge', async () => {
  const p1 = feedContext({
    input: {page: 1, unread_only: 0, bucket: 'task'},
    baseRows: [task(1)],
    rollups: [{category: 'hub_invite', key_id: '1060', hub_id: 'h1', ctime: 3}],
    contactRows: {task_mention: [task(1)]},
  });
  await p1.activity.get_feed();
  // No contact rows merged (they are in the base feed), no rollup leaks in.
  assert.deepEqual(p1.listed().map((r) => r.id), [1]);
});

test('Unread ON keeps paging task rows past the first 50', async () => {
  const many = Array.from({length: 120}, (_, i) => task(i + 1));
  const ids = async (page) => {
    const ctx = feedContext({
      input: {page, unread_only: 1, bucket: 'task'},
      baseRows: [],
      contactRows: {task_mention: many},
    });
    await ctx.activity.get_feed();
    return ctx.listed().map((r) => r.id);
  };
  const seen = [...await ids(1), ...await ids(2), ...await ids(3)];
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual(await ids(4), []);
});

const fileRow = (id, extra = {}) => ({
  id, event: 'media.new', event_type: 'mfs', timestamp: 500 + id, is_read: 0, ...extra,
});

test('Unread OFF on a tab pages that tab only (activity_get_feed_bucket)', async () => {
  const ctx = feedContext({
    input: {page: 2, unread_only: 0, bucket: 'files'},
    baseRows: [task(1), task(2)], // what the whole feed would have answered
    bucketRows: [fileRow(2), fileRow(1)], // newest first, as the procedure answers
  });
  await ctx.activity.get_feed();
  assert.deepEqual(ctx.listed().map((r) => r.id), [2, 1]);
  const feedCalls = ctx.calls.filter(([p]) => p.startsWith('activity_get_feed'));
  assert.deepEqual(feedCalls, [['activity_get_feed_bucket', 'me', 2, 'files']]);
});

test('Unread OFF on a tab falls back to the whole feed while activity_get_feed_bucket is absent', async () => {
  const ctx = feedContext({
    input: {page: 1, unread_only: 0, bucket: 'files'},
    baseRows: [task(1), fileRow(3)],
  });
  await ctx.activity.get_feed();
  assert.deepEqual(ctx.listed().map((r) => r.id), [3]);
  assert.deepEqual(
    ctx.calls.filter(([p]) => p.startsWith('activity_get_feed')).map(([p]) => p),
    ['activity_get_feed_bucket', 'activity_get_feed_all'],
  );
  // Same database within the cooldown: the missing routine is not asked again.
  ctx.calls.length = 0;
  await ctx.activity.get_feed();
  assert.deepEqual(
    ctx.calls.filter(([p]) => p.startsWith('activity_get_feed')).map(([p]) => p),
    ['activity_get_feed_all'],
  );
});

test('All (no tab) and Unread ON never use activity_get_feed_bucket', async () => {
  for (const input of [
    {page: 1, unread_only: 0},
    {page: 1, unread_only: 1, bucket: 'files'},
    {page: 1, unread_only: 0, bucket: 'files', filter: 'mentions'},
  ]) {
    const ctx = feedContext({input, baseRows: [fileRow(1)], bucketRows: []});
    await ctx.activity.get_feed();
    assert.ok(!ctx.calls.some(([p]) => p === 'activity_get_feed_bucket'), JSON.stringify(input));
  }
});
