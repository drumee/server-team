const assert = require('node:assert/strict');
const test = require('node:test');

const { SORTS, DEFAULT_SORT, trashSort, showBinCall } = require('../service/lib/trash-sort');

test('accepts the three sorts verbatim', () => {
  for (const s of ['latest', 'earliest', 'expiring']) assert.equal(trashSort(s), s);
});

test('anything else falls back to latest', () => {
  for (const s of [undefined, null, '', 'undefined', 'LATEST', 'oldest', 1, {}]) {
    assert.equal(trashSort(s), DEFAULT_SORT);
  }
});

test('latest keeps calling the one-arg proc, so an unpatched instance still answers', () => {
  assert.deepEqual(showBinCall(2, 'latest'), ['mfs_show_bin', 2]);
  assert.deepEqual(showBinCall(1, undefined), ['mfs_show_bin', 1]);
});

test('earliest / expiring call mfs_show_bin_next with the sort', () => {
  assert.deepEqual(showBinCall(1, 'earliest'), ['mfs_show_bin_next', 1, 'earliest']);
  assert.deepEqual(showBinCall(3, 'expiring'), ['mfs_show_bin_next', 3, 'expiring']);
});

test('acl/media.json show_bin.sort enum mirrors SORTS', () => {
  const { sort } = require('../acl/media.json').services.show_bin.params;
  assert.deepEqual(sort.enum, SORTS);
  assert.equal(sort.default, DEFAULT_SORT);
});
