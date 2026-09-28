/**
 * media.show_bin `sort` values. Mirrors acl/media.json's enum and
 * mfs_show_bin_sorted's accepted _sort values.
 *
 * `latest` (the default, and the only order before the param existed) keeps
 * calling the one-arg mfs_show_bin: that name exists on every instance,
 * including any the mfs_show_bin_sorted patch has not reached yet.
 */
const SORTS = Object.freeze(['latest', 'earliest', 'expiring']);
const DEFAULT_SORT = 'latest';

function trashSort(value) {
  return SORTS.includes(value) ? value : DEFAULT_SORT;
}

function showBinCall(page, sort) {
  const s = trashSort(sort);
  return s === DEFAULT_SORT ? ['mfs_show_bin', page] : ['mfs_show_bin_sorted', page, s];
}

module.exports = { SORTS, DEFAULT_SORT, trashSort, showBinCall };
