// A stored (already read) rollup at a workspace ROOT is named with the
// viewer's current desk label, not the name captured in its snapshot.
//
// The payload in notification_rollup is a snapshot. For a root row its name
// came from yp.hub.name, which a desk rename never writes, so the panel read
// "V started a meeting in <name the workspace was created with>" while the
// desk and the opened workspace showed the viewer's own name for it.
// notification_rollup_list now returns that label as hub_label.
//
// Run: node --test test/notification-rollup-workspace-label.test.js
const assert = require('node:assert/strict');
const test = require('node:test');

const Activity = require('../service/private/activity');

function activityWith(rows) {
  const activity = Object.create(Activity.prototype);
  activity.uid = 'me';
  activity.debug = () => undefined;
  activity._callUserProc = async (proc) => {
    assert.equal(proc, 'notification_rollup_list');
    return rows;
  };
  return activity;
}

function stored(payload, extra = {}) {
  return {
    category: payload.category,
    key_id: payload.key_id,
    hub_id: payload.hub_id,
    payload: JSON.stringify(payload),
    ctime: 100,
    ...extra,
  };
}

const meetingAtRoot = {
  category: 'teamchat',
  key_id: 'root-1',
  hub_id: 'hub-1',
  nid: 'root-1',
  parent_id: '0',
  filename: 'Old name',
  folder_name: 'Old name',
  surname: 'Old name',
  meeting_action: 'start',
};

test('a workspace-root row takes the viewer\'s desk label', async () => {
  const [row] = await activityWith([
    stored(meetingAtRoot, { hub_label: 'New name' }),
  ])._storedRollups();
  assert.equal(row.filename, 'New name');
  assert.equal(row.folder_name, 'New name');
  assert.equal(row.meeting_action, 'start');
});

test('a media upload at the root keeps the uploaded file\'s own name', async () => {
  const [row] = await activityWith([
    stored({
      category: 'media',
      key_id: 'root-1',
      hub_id: 'hub-1',
      parent_id: '0',
      filename: 'Old name',
      folder_name: 'Old name',
      link_label: 'Old name',
      item_filename: 'report.pdf',
    }, { hub_label: 'New name' }),
  ])._storedRollups();
  assert.equal(row.filename, 'New name');
  assert.equal(row.folder_name, 'New name');
  assert.equal(row.link_label, 'New name');
  assert.equal(row.item_filename, 'report.pdf');
});

test('a folder below the root keeps its own name', async () => {
  const [row] = await activityWith([
    stored({ ...meetingAtRoot, parent_id: 'root-1', filename: 'Specs', folder_name: 'Specs' },
      { hub_label: 'New name' }),
  ])._storedRollups();
  assert.equal(row.filename, 'Specs');
  assert.equal(row.folder_name, 'Specs');
});

test('no label (old procedure, or not on this desk) leaves the snapshot as is', async () => {
  for (const extra of [{}, { hub_label: null }, { hub_label: '' }]) {
    const [row] = await activityWith([stored(meetingAtRoot, extra)])._storedRollups();
    assert.equal(row.filename, 'Old name');
    assert.equal(row.folder_name, 'Old name');
  }
});

test('a p2p chat row is untouched', async () => {
  const [row] = await activityWith([
    stored({ category: 'chat', key_id: 'peer', hub_id: 'me', parent_id: null, filename: 'Lexis Hoang' },
      { hub_label: 'Anything' }),
  ])._storedRollups();
  assert.equal(row.filename, 'Lexis Hoang');
});

// Raw mfs_changelog rows ("created folder Customers") get their chip from
// _stampFolderNames, whose mfs_node_attr lookup names the workspace ROOT by
// its shared name. The chip must name it the way the viewer's desk does.
function stampWith({ attrs, label, labelThrows }) {
  const activity = Object.create(Activity.prototype);
  activity.uid = 'me';
  activity.debug = () => undefined;
  const userCalls = [];
  activity.yp = {
    await_proc: async (proc, hubId, inner, parent) => {
      assert.equal(proc, 'forward_proc');
      assert.equal(inner, 'mfs_node_attr');
      return [attrs[parent.replace(/'/g, '')] || {}];
    },
  };
  activity._callUserProc = async (proc, uid, hubId) => {
    userCalls.push([proc, uid, hubId]);
    if (labelThrows) throw new Error('boom');
    return [label == null ? {} : { filetype: 'hub', filename: label }];
  };
  return { activity, userCalls };
}

function changelogRow(parent) {
  return { event: 'media.new', hub_id: 'hub-1', dest: JSON.stringify({ parent_id: parent }) };
}

test('a file at the workspace root names the workspace as the desk does', async () => {
  const { activity, userCalls } = stampWith({
    attrs: { root: { filename: 'Old name', parent_id: '0' } },
    label: 'New name',
  });
  const rows = [changelogRow('root'), changelogRow('root')];
  await activity._stampFolderNames(rows);
  assert.equal(rows[0].folder_name, 'New name');
  assert.equal(rows[1].folder_name, 'New name');
  assert.deepEqual(userCalls, [['mfs_access_node', 'me', 'hub-1']]); // one lookup per workspace
});

test('a file in a sub-folder keeps the folder name, with no label lookup', async () => {
  const { activity, userCalls } = stampWith({
    attrs: { sub: { filename: 'Specs', parent_id: 'root' } },
    label: 'New name',
  });
  const rows = [changelogRow('sub')];
  await activity._stampFolderNames(rows);
  assert.equal(rows[0].folder_name, 'Specs');
  assert.equal(userCalls.length, 0);
});

test('no desk label, or a failing lookup, keeps the shared name', async () => {
  for (const opts of [{ label: null }, { labelThrows: true }]) {
    const { activity } = stampWith({
      attrs: { root: { filename: 'Old name', parent_id: '0' } },
      ...opts,
    });
    const rows = [changelogRow('root')];
    await activity._stampFolderNames(rows);
    assert.equal(rows[0].folder_name, 'Old name');
  }
});
