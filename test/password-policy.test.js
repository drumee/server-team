const assert = require('node:assert/strict');
const test = require('node:test');

const { missingPasswordRules } = require('../service/lib/password-policy');

test('a password meeting every signup rule has nothing missing', () => {
  assert.deepEqual(missingPasswordRules('Abcdefg1!'), []);
});

test('the old 8-character-only check no longer passes', () => {
  assert.deepEqual(missingPasswordRules('abcdefgh'), [
    'PW_NEEDS_UPPERCASE', 'PW_NEEDS_NUMBER', 'PW_NEEDS_SYMBOL',
  ]);
});

test('each rule is reported on its own', () => {
  assert.deepEqual(missingPasswordRules('Abc1!'), ['PW_NEEDS_MIN']);
  assert.deepEqual(missingPasswordRules('abcdefg1!'), ['PW_NEEDS_UPPERCASE']);
  assert.deepEqual(missingPasswordRules('Abcdefgh!'), ['PW_NEEDS_NUMBER']);
  assert.deepEqual(missingPasswordRules('Abcdefgh1'), ['PW_NEEDS_SYMBOL']);
});

test('empty and missing input fail every rule instead of throwing', () => {
  assert.equal(missingPasswordRules('').length, 4);
  assert.equal(missingPasswordRules(undefined).length, 4);
});
