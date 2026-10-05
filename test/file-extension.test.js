const assert = require('node:assert/strict');
const test = require('node:test');

const { safeExtension, EXTENSION_MAX } = require('../service/lib/file-extension');

test('keeps plain extensions as given', () => {
  for (const e of [
    'pdf', 'jpg', 'JPG', 'docx', 'mp4', '7z', 'tar.bz2', 'd.ts', 'js.map',
    'drumee.html', 'skl.json', 'mkvtimestamp_v2', 'g723_1', 'asf_stream', 'x-y',
  ]) {
    assert.equal(safeExtension(e), e);
  }
});

test('drops anything that is not a plain extension', () => {
  for (const e of [
    '', ' ', 'a b', 'a;b', 'a|b', 'a&b', 'a$b', 'a`b', "a'b", 'a"b', 'a/b', 'a\\b',
    'a\nb', '.pdf', 'pdf.', 'a..b', 'a._b', '-pdf', 'pdf-', '_pdf', 'é', 'a*', 'a?',
    'a(b)', 'a~', '#a', '%20',
  ]) {
    assert.equal(safeExtension(e), '', JSON.stringify(e));
  }
});

test('limits the length to the width of yp.filecap.extension', () => {
  assert.equal(safeExtension('a'.repeat(EXTENSION_MAX)), 'a'.repeat(EXTENSION_MAX));
  assert.equal(safeExtension('a'.repeat(EXTENSION_MAX + 1)), '');
});

test('non-string input', () => {
  assert.equal(safeExtension(undefined), '');
  assert.equal(safeExtension(null), '');
  assert.equal(safeExtension(12), '12');
  assert.equal(safeExtension({}), '');
});
