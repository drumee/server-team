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
