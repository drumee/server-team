const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

test('activity.get_feed exposes the mobile full-feed controls and safe fields', () => {
  const acl = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'acl/activity.json'),
    'utf8',
  ));
  const feed = acl.services.get_feed;

  assert.equal(feed.params.page.type, 'integer');
  assert.equal(feed.params.filter.type, 'string');
  assert.equal(feed.params.unread_only.type, 'integer');
  assert.deepEqual(feed.params.unread_only.default, 0);

  const fields = feed.returns.items.properties;
  for (const field of [
    'id', 'key_id', 'category', 'event', 'event_type', 'feed_page_source', 'filename',
    'timestamp', 'ctime', 'is_read', 'src', 'dest', 'data',
  ]) {
    assert.ok(fields[field], `missing activity.get_feed field: ${field}`);
  }

  for (const service of [
    'mark_all_read', 'read', 'dismiss', 'dismiss_contact_event',
    'dismiss_rollup', 'dismiss_history', 'bookmark_add', 'bookmark_remove',
  ]) {
    assert.equal(
      acl.services[service].permission.src,
      'read',
      `${service} must use the authenticated personal-state capability`,
    );
  }
  assert.equal(acl.services.read.params.last_id.required, true);
  assert.equal(acl.services.dismiss_rollup.params.last_id.required, true);
  assert.equal(acl.services.notification_dismiss.params.last_id.required, true);
});

test('merged unread rollups declare their read state before output', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'service/private/activity.js'),
    'utf8',
  );

  assert.match(source, /if \(r\.is_read == null\) r\.is_read = 0;/);
  assert.match(source, /row\.feed_page_source = 'base'/);
  assert.doesNotMatch(source, /falling back to activity_get_log/);
  assert.match(source, /this\.output\.list\(await this\._notificationRollups\(\)\)/);
  assert.match(source, /\['chat', 'teamchat', 'ticket'\]\.includes\(category\)/);
  assert.match(source, /'notification_read',[\s\S]*parseInt\(r\.ctime \|\| 0\)/);
  assert.match(source, /'notification_history_hide'/);
  assert.match(source, /case 'chat': keyId = firstValue\(r\.drumate_id, r\.key_id\)/);
  assert.match(source, /notification_activity_bookmark_add/);
  assert.match(source, /\^\[a-f0-9\]\{64\}\$/);
  const bookmarkSource = source.slice(
    source.indexOf('function bookmarkKey(row)'),
    source.indexOf('// Surface task fields'),
  );
  assert.match(bookmarkSource, /row\.key_id, row\.history_id, row\.id/);
  assert.doesNotMatch(
    bookmarkSource,
    /row\.last_id/,
    'bookmark identity must survive rollup advancement and read-history snapshots',
  );
  assert.match(source, /const proc = `\$\{this\.user\.get\(Attr\.db_name\)\}\.\$\{procName\}`/);
  const markAllSource = source.slice(
    source.indexOf('async mark_all_read()'),
    source.indexOf('async get_feed()'),
  );
  assert.ok(
    markAllSource.indexOf("notification_center_next") <
      markAllSource.indexOf("'mfs_mark_all_read'"),
    'mark-all must snapshot unread rollups before advancing P2P read pointers',
  );
});

test('bookmark identity stays stable across unread and full-feed contact representations', () => {
  const Activity = require('../service/private/activity');
  const contactActivityId = 417;

  const unreadHubInvite = Activity.bookmarkKey({
    category: 'hub_invite',
    key_id: String(contactActivityId),
    hub_id: 'workspace-from-unread-adapter',
  });
  const fullFeedHubInvite = Activity.bookmarkKey({
    event: 'hub_invite_received',
    event_type: 'contact',
    id: contactActivityId,
    hub_id: null,
  });

  assert.equal(unreadHubInvite, fullFeedHubInvite);
  assert.equal(unreadHubInvite?.length, 64);
});

test('saved chat identity survives rollup advancement and read-history conversion', () => {
  const Activity = require('../service/private/activity');
  const unreadChat = Activity.bookmarkKey({
    category: 'chat',
    key_id: '0123456789abcdef',
    hub_id: 'fedcba9876543210',
    last_id: 17,
  });
  const readHistory = Activity.bookmarkKey({
    event: 'notification.history',
    event_type: 'notification_history',
    category: 'chat',
    key_id: '0123456789abcdef',
    hub_id: 'fedcba9876543210',
    last_id: 99,
    history_id: 123,
  });

  assert.equal(unreadChat, readHistory);
});

test('rollup mutation resolves only a canonical currently visible identity', async () => {
  const Activity = require('../service/private/activity');
  const activity = Object.create(Activity.prototype);
  activity._notificationRollups = async () => [{
    category: 'teamchat',
    key_id: '0123456789abcdef',
    hub_id: 'fedcba9876543210',
    last_id: 31,
  }];

  const visible = await activity._visibleNotificationRollup(
    'teamchat',
    '0123456789abcdef',
    'fedcba9876543210',
    31,
  );
  const forged = await activity._visibleNotificationRollup(
    'teamchat',
    "x' OR 1=1 --",
    'fedcba9876543210',
    31,
  );
  const stale = await activity._visibleNotificationRollup(
    'teamchat',
    '0123456789abcdef',
    'fedcba9876543210',
    30,
  );

  assert.equal(visible.last_id, 31);
  assert.equal(forged, null);
  assert.equal(stale, null);
});

test('legacy contact mutation remains canonical without a synthetic last id', async () => {
  const Activity = require('../service/private/activity');
  const activity = Object.create(Activity.prototype);
  activity._notificationRollups = async () => [{
    category: 'contact',
    key_id: '0123456789abcdef',
    hub_id: '',
  }];

  const visible = await activity._visibleNotificationRollup(
    'contact',
    '0123456789abcdef',
    '',
    0,
  );

  assert.equal(visible.key_id, '0123456789abcdef');
});

test('media and chat reads resolve by the key the dismiss proc acts on', async () => {
  const Activity = require('../service/private/activity');
  const calls = [];
  const rollups = [{
    category: 'media',
    key_id: 'e5ece49ee5ece4a1', // the uploader's contact, NOT the folder
    nid: '8e623a8c8e623a8f',
    hub_id: '8e34ce938e34ce95',
    last_id: 1399,
  }, {
    category: 'media',
    key_id: 'c4871e5fc4871e6d',
    nid: null, // folder no longer resolves
    hub_id: 'c4871e5fc4871e6d',
    last_id: 142,
  }, {
    category: 'chat',
    key_id: 'e5ece49ee5ece4a1', // the contact id
    drumate_id: 'b6e6cdd0b6e6cdd6',
    hub_id: 'current-user',
    last_id: 1790318086,
  }];
  const run = async (params) => {
    const context = Object.create(Activity.prototype);
    context._notificationRollups = async () => rollups;
    context.input = {
      need: (k) => params[k],
      use: (k) => params[k],
    };
    context.exception = {bad_request: code => ({error: code})};
    context.output = {data: d => d};
    context._callUserProc = async (...args) => { calls.push(args); return [{status: 'ok'}]; };
    return context.notification_dismiss();
  };

  await run({category: 'media', key_id: '8e623a8c8e623a8f', hub_id: '8e34ce938e34ce95', last_id: 1399});
  await run({category: 'media', key_id: 'c4871e5fc4871e6d', hub_id: 'c4871e5fc4871e6d', last_id: 142});
  await run({category: 'chat', key_id: 'b6e6cdd0b6e6cdd6', hub_id: 'current-user', last_id: 1790318086});
  assert.deepEqual(calls, [
    ['notification_dismiss', 'media', '8e623a8c8e623a8f', '8e34ce938e34ce95', 1399],
    ['notification_dismiss', 'media', 'c4871e5fc4871e6d', 'c4871e5fc4871e6d', 142],
    ['notification_dismiss', 'chat', 'b6e6cdd0b6e6cdd6', 'current-user', 1790318086],
  ]);

  // Still only a live row: a stale last_id or an unknown key is refused.
  calls.length = 0;
  const stale = await run({category: 'media', key_id: '8e623a8c8e623a8f', hub_id: '8e34ce938e34ce95', last_id: 1398});
  const forged = await run({category: 'media', key_id: 'ffffffffffffffff', hub_id: '8e34ce938e34ce95', last_id: 1399});
  assert.deepEqual(stale, {error: 'INVALID_DATA'});
  assert.deepEqual(forged, {error: 'INVALID_DATA'});
  assert.equal(calls.length, 0);
});

test('support-ticket rollups expose a positive snapshot id', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, '..', 'schemas', 'drumate', 'procedures',
      'notification', 'notification_center_next.sql'),
    'utf8',
  );
  assert.match(
    source,
    /t\.last_sys_id, t\.utime, 'personal', 'ticket'/,
  );
  assert.doesNotMatch(
    source,
    /t\.ticket_id,\s*t\.ticket_id\s*,\s*'Support Ticket'[\s\S]{0,100}NULL,c\.ctime/,
  );
});

test('mark-all fails closed before the global pointer after a rollup failure', async () => {
  const Activity = require('../service/private/activity');
  const calls = [];
  const failure = {status: 'error'};
  const context = {
    uid: 'current-user',
    // `use('bucket')` returns undefined -> unscoped clear, the path this test pins.
    input: {get: () => 0, use: () => undefined},
    debug: () => undefined,
    warn: () => undefined,
    exception: {server: code => ({...failure, code})},
    async _callUserProc(proc) {
      calls.push(proc);
      if (proc === 'notification_center_next') {
        return [{
          category: 'chat',
          drumate_id: '0123456789abcdef',
          hub_id: 'current-user',
          last_id: 19,
          ctime: 20,
        }];
      }
      if (proc === 'notification_read') throw new Error('snapshot unavailable');
      throw new Error(`unexpected procedure: ${proc}`);
    },
  };

  const result = await Activity.prototype.mark_all_read.call(context);

  assert.deepEqual(result, {...failure, code: 'MARK_ALL_READ_FAILED'});
  assert.deepEqual(calls, ['notification_center_next', 'notification_read']);
  assert.ok(!calls.includes('mfs_mark_all_read'));
});

test('Unread OFF shows a contact row as unread only when the badge counts it', async () => {
  const Activity = require('../service/private/activity');
  const calls = [];
  const activity = Object.create(Activity.prototype);
  activity.uid = 'me';
  activity.debug = () => undefined;
  activity._optionalYpProc = async (proc) => (
    proc === 'contact_invite_accepted_unread' ? [{id: 726}] : []
  );
  activity._callUserProc = async (proc) => {
    calls.push(proc);
    if (proc === 'notification_hub_invites') return [{id: 784}];
    if (proc === 'notification_contact_refused') return [];
    throw new Error(`unexpected procedure: ${proc}`);
  };
  const base = {feed_page_source: 'base', event_type: 'contact', is_read: 0};
  const rows = [
    {...base, id: 726, event: 'invite_accepted', uid: 'A', timestamp: 90},
    {...base, id: 688, event: 'invite_sent', uid: 'B', timestamp: 100},
    {...base, id: 682, event: 'invite_received', uid: 'B', timestamp: 100},
    {...base, id: 600, event: 'invite_received', uid: 'B', timestamp: 50},
    {...base, id: 700, event: 'invite_received', uid: 'C', timestamp: 70},
    {...base, id: 784, event: 'hub_invite_received', uid: 'D', timestamp: 60},
    {...base, id: 780, event: 'hub_invite_received', uid: 'D', timestamp: 40},
    {...base, id: 9, event: 'task_mention', uid: 'E', is_read: 1},
    {feed_page_source: 'base', event_type: 'mfs', id: 5, event: 'media.new', is_read: 0},
  ];

  await activity._alignContactReadState(rows, [{category: 'contact', drumate_id: 'B'}]);

  const state = Object.fromEntries(rows.map((r) => [r.id, r.is_read]));
  assert.deepEqual(state, {
    726: 0, // counted (contact_invite_accepted_unread)
    688: 1, // duplicate of the invitation
    682: 0, // newest invitation from a pending inviter
    600: 1, // older copy
    700: 1, // inviter no longer pending
    784: 0, // live workspace invite
    780: 1, // superseded workspace invite
    9: 1,
    5: 0,   // mfs rows are not touched
  });
  // Page 1 reuses the rollups: no pending-invitation lookup.
  assert.ok(!calls.includes('contact_notification_get'));
});

test('Unread OFF contact read state fails open and uses the light list past page 1', async () => {
  const Activity = require('../service/private/activity');
  const make = (answers) => {
    const activity = Object.create(Activity.prototype);
    activity.uid = 'me';
    activity.debug = () => undefined;
    activity._optionalYpProc = async () => [];
    activity._callUserProc = async (proc) => answers[proc];
    return activity;
  };
  const row = () => [{feed_page_source: 'base', event_type: 'contact', is_read: 0,
    id: 682, event: 'invite_received', uid: 'B', timestamp: 1}];

  // A source that could not be read leaves the rows exactly as they were.
  const failed = row();
  await make({notification_hub_invites: undefined, notification_contact_refused: []})
    ._alignContactReadState(failed, [{category: 'contact', drumate_id: 'B'}]);
  assert.equal(failed[0].is_read, 0);

  // Page 2+: pending inviters come from contact_notification_get.
  const pending = row();
  await make({notification_hub_invites: [], notification_contact_refused: [],
    contact_notification_get: [{drumate_id: 'B'}]})._alignContactReadState(pending, null);
  assert.equal(pending[0].is_read, 0);
  const gone = row();
  await make({notification_hub_invites: [], notification_contact_refused: [],
    contact_notification_get: []})._alignContactReadState(gone, null);
  assert.equal(gone[0].is_read, 1);
});

test('Mark as all read on Other clears every Other source it counts', async () => {
  const Activity = require('../service/private/activity');
  const user = [];
  const yp = [];
  let refusedReads = 0;
  const context = {
    uid: 'me',
    input: {get: () => 0, use: (k) => (k === 'bucket' ? 'other' : undefined)},
    debug: () => undefined,
    warn: () => undefined,
    output: {data: d => d},
    yp: {await_proc: async (...args) => { yp.push(args); return [{status: 'ok'}]; }},
    async _optionalYpProc(proc) {
      return proc === 'contact_invite_accepted_unread' ? [{id: 726}] : [];
    },
    async _optionalYpProcResult(proc, ...args) {
      yp.push([proc, ...args]);
      return {ok: true, rows: [{status: 'ok'}]};
    },
    _markContactRead: Activity.prototype._markContactRead,
    async _callUserProc(proc, ...args) {
      user.push([proc, ...args]);
      if (proc === 'notification_center_next') return [];
      if (proc === 'notification_hub_invites') {
        return [{id: 2, data: '{"hub_id":"h1"}'}, {id: 3, data: '{"hub_id":"h2"}'}];
      }
      if (proc === 'notification_contact_refused') {
        refusedReads += 1;
        return refusedReads === 1 ? [{id: 7}] : [];
      }
      return [{status: 'ok'}];
    },
  };

  const result = await Activity.prototype.mark_all_read.call(context);

  assert.equal(result.status, 'ok');
  assert.equal(result.bucket, 'other');
  // Marked READ (dismissed_at only), never removed from history.
  assert.deepEqual(
    yp.filter(([p]) => p === 'contact_activity_mark_read').map(([, , id]) => id),
    [726, 7],
  );
  assert.ok(!user.some(([p]) => p === 'contact_activity_dismiss'));
  assert.deepEqual(
    yp.filter(([p]) => p === 'contact_activity_dismiss_hub_invite').map(([, , hub]) => hub),
    ['h1', 'h2'],
  );
  // Other never touches the Files pointers.
  assert.ok(!user.some(([p]) => p === 'mfs_mark_all_read'));
});

test('reading a contact notification marks it read without removing it', async () => {
  const Activity = require('../service/private/activity');
  const make = (applied) => {
    const calls = [];
    const activity = Object.create(Activity.prototype);
    activity.uid = 'me';
    activity.input = {need: () => '726'};
    activity.exception = {bad_request: code => ({error: code})};
    activity.output = {data: d => { activity.sent = d; return d; }};
    activity._optionalYpProcResult = async (proc, ...args) => {
      calls.push([proc, ...args]);
      return applied ? {ok: true, rows: [{status: 'ok', activity_id: 726}]} : {ok: false, rows: []};
    };
    activity._callUserProc = async (proc, ...args) => {
      calls.push([proc, ...args]);
      return [{status: 'ok', activity_id: 726}];
    };
    return {activity, calls};
  };

  const live = make(true);
  await live.activity.read_contact_event();
  assert.deepEqual(live.activity.sent, {status: 'ok', activity_id: 726});
  assert.deepEqual(live.calls, [['contact_activity_mark_read', 'me', 726]]);

  // Proc not applied yet: fall back to the previous read (+hide), never lose the read.
  const rollout = make(false);
  await rollout.activity.read_contact_event();
  assert.deepEqual(rollout.calls.map(([p]) => p), ['contact_activity_mark_read', 'contact_activity_dismiss']);

  const bad = make(true);
  bad.activity.input = {need: () => 'x'};
  assert.deepEqual(await bad.activity.read_contact_event(), {error: 'INVALID_DATA'});
});
