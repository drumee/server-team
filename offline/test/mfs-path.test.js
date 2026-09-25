#!/usr/bin/env node
//
// mfs-path.test.js — path columns written by unzip / serverimport.
//
//   node offline/test/mfs-path.test.js
//
// Both workers bulk-insert through mfs_import, which stores parent_path and
// file_path exactly as given. They used to build them with path.join, which
// gave "." / "cye" / "cye/x.pdf" at a hub root; exact file_path lookups and
// node_id_from_path then failed for everything inside the unzipped folder.
// The expected values below are what parent_path() / filepath() return.
//
// Exit code 0 = all pass, 1 = any failure.

const assert = require('assert');
const { childPaths, folderPath, nodeFolder } = require('../../service/lib/mfs-path');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}

// mfs_access_node on a hub's home: file_path "/", parent_path "", filename "".
const HOME = { ownpath: '/', parent_path: '', filename: '' };

check('unzip at hub root gives an absolute folder', () => {
  assert.deepStrictEqual(childPaths(nodeFolder(HOME), 'cye'),
    { parent_path: '/', file_path: '/cye' });
});

check('child of that folder', () => {
  assert.deepStrictEqual(childPaths('/cye', 'x.pdf'),
    { parent_path: '/cye/', file_path: '/cye/x.pdf' });
});

check('unzip into a subfolder keeps the trailing slash on parent_path', () => {
  assert.deepStrictEqual(childPaths(nodeFolder({ ownpath: '/ws/sub' }), 'cye'),
    { parent_path: '/ws/sub/', file_path: '/ws/sub/cye' });
});

check('destination still holding a legacy relative path', () => {
  assert.deepStrictEqual(childPaths(nodeFolder({ ownpath: 'cye/in' }), 'z'),
    { parent_path: '/cye/in/', file_path: '/cye/in/z' });
});

check('no ownpath: falls back to parent_path + filename', () => {
  assert.strictEqual(nodeFolder({ parent_path: '', filename: '' }), '/');
  assert.strictEqual(nodeFolder({ parent_path: '/ws/', filename: 'sub' }), '/ws/sub');
});

check('"." and duplicate slashes collapse, dot-names survive', () => {
  assert.strictEqual(folderPath('.'), '/');
  assert.strictEqual(folderPath('//a//b/'), '/a/b');
  assert.deepStrictEqual(childPaths('/a', '.git'),
    { parent_path: '/a/', file_path: '/a/.git' });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
