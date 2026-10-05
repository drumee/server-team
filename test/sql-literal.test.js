const assert = require('node:assert/strict');
const test = require('node:test');

const { sqlLiteral, sqlString } = require('../service/lib/sql-literal');

test("sqlString gives the same text as the old '${value}' for values without ' or \\", () => {
  for (const v of [
    'a1b2c3d4e5f60718', 'sender-uid', 'date', '', 0, 1, 42, -3, 1.5, true, false,
    undefined, null, '["x","y"]', JSON.stringify({ a: 1, b: [1, 2] }), 'é ü 漢字 👋',
  ]) {
    assert.equal(sqlString(v), `'${v}'`, String(v));
  }
});

test('sqlString escapes quotes and backslashes', () => {
  assert.equal(sqlString("it's"), "'it''s'");
  assert.equal(sqlString('a\\b'), "'a\\\\b'");
  assert.equal(sqlString("x\\'"), "'x\\\\'''");
  assert.equal(sqlString(JSON.stringify({ m: "it's \"q\"" })), `'{"m":"it''s \\\\"q\\\\""}'`);
});

test('sqlLiteral keeps its null / undefined as empty string', () => {
  assert.equal(sqlLiteral(undefined), "''");
  assert.equal(sqlLiteral(null), "''");
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral('a\\b'), "'a\\\\b'");
});

test('no escaped value can end the literal early', () => {
  const tricky = ["'", "\\", "\\'", "''", "a'b\\", "\\\\'", "x');--"];
  for (const v of [...tricky, ...tricky.map((t) => t + t)]) {
    const lit = sqlString(v).slice(1, -1);
    // Inside the literal, every ' is doubled and every \ is doubled.
    assert.ok(!/(^|[^'])'([^']|$)/.test(lit.replace(/''/g, '')), v);
    assert.equal(lit.replace(/\\\\/g, '').includes('\\'), false, v);
  }
});
