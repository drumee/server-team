// archive-tree.test.js — a downloaded zip holds exactly what was selected.
//
//   node --test test/archive-tree.test.js
//
// The zip was laid out by the stored media.file_path, which drifts. The rows
// below are stage's (hub ff7469e5ff7469ea, 2026-10-09): selecting "rrr" and
// "888" produced a zip with "888.", "888", "rrr" and an unselected "test".
const assert = require('node:assert/strict');
const test = require('node:test');
const { archiveTree, entryName } = require('../service/lib/archive-tree');

const RRR = 'e2fa0755e2fa0758';
const N888 = '4cf658034cf65808';
const PARENT = '002ef9cb002ef9d1';

const rrrManifest = [
  { nid: RRR, pid: PARENT, filename: 'rrr', ext: '', filetype: 'folder', filepath: '/rrr' },
];
const manifest888 = [
  { nid: N888, pid: PARENT, filename: '888', ext: '', filetype: 'folder', filepath: '/888.' },
  { nid: '5087b6a85087b6ac', pid: N888, filename: '999', ext: '', filetype: 'folder', filepath: '/888/999.' },
  {
    nid: '5e68c5e05e68c5e5', pid: N888, filetype: 'document', ext: 'docx',
    filename: 'FNSFMB412 - Role Play Script (Monique Blush Part C) - Johnny Phan',
    filepath: '/test/888/FNSFMB412 - Role Play Script (Monique Blush Part C) - Johnny Phan.docx',
  },
  {
    nid: 'd1ee6616d1ee661a', pid: N888, filetype: 'text', ext: 'txt',
    filename: 'Will do list for follow up those lead',
    filepath: '/888/Will do list for follow up those lead.txt',
  },
];

const layout = (...lists) => lists.flat().map((r) => r.filepath).sort();

test('stage selection: exactly rrr/ and 888/, no "888." and no "test"', () => {
  const taken = new Set();
  const out = [archiveTree(rrrManifest, RRR, taken), archiveTree(manifest888, N888, taken)];
  assert.deepEqual(layout(...out), [
    '888',
    '888/999',
    '888/FNSFMB412 - Role Play Script (Monique Blush Part C) - Johnny Phan.docx',
    '888/Will do list for follow up those lead.txt',
    'rrr',
  ]);
});

test('nested selections are rooted at the selected item, not at the hub root', () => {
  const rows = [
    { nid: 'b', pid: 'a', filename: 'deep', ext: '', filetype: 'folder', filepath: '/x/y/deep' },
    { nid: 'c', pid: 'b', filename: 'f', ext: 'pdf', filetype: 'document', filepath: '/x/y/deep/f.pdf' },
  ];
  assert.deepEqual(layout(archiveTree(rows, 'b')), ['deep', 'deep/f.pdf']);
});

test('two selected items with one name do not merge', () => {
  const taken = new Set();
  const a = archiveTree([{ nid: '1', pid: 'p', filename: 'Docs', ext: '', filetype: 'folder' }], '1', taken);
  const b = archiveTree([{ nid: '2', pid: 'q', filename: 'docs', ext: '', filetype: 'folder' }], '2', taken);
  const c = archiveTree([{ nid: '3', pid: 'q', filename: 'a', ext: 'txt', filetype: 'text' }], '3', taken);
  const d = archiveTree([{ nid: '4', pid: 'r', filename: 'a', ext: 'txt', filetype: 'text' }], '4', taken);
  assert.deepEqual(layout(a, b, c, d), ['Docs', 'a (2).txt', 'a.txt', 'docs (2)']);
});

test('a workspace in the selection: its content hangs off its home node', () => {
  const rows = [
    { nid: 'hubnode', pid: 'p', filename: 'Team', ext: '', filetype: 'hub', home_id: 'home1' },
    { nid: 'f1', pid: 'home1', filename: 'plan', ext: 'pdf', filetype: 'document' },
  ];
  assert.deepEqual(layout(archiveTree(rows, 'hubnode')), ['Team', 'Team/plan.pdf']);
});

test('a selected workspace root (not listed by the manifest) takes its given name', () => {
  const rows = [{ nid: 'f1', pid: 'home9', filename: 'notes', ext: 'md', filetype: 'note' }];
  assert.deepEqual(layout(archiveTree(rows, 'home9', new Set(), 'Sales')), ['Sales/notes.md']);
});

test('an orphan stays in the zip, inside its selection', () => {
  const rows = [
    { nid: 'r', pid: 'p', filename: 'top', ext: '', filetype: 'folder' },
    { nid: 'o', pid: 'gone', filename: 'lost', ext: 'png', filetype: 'image' },
  ];
  assert.deepEqual(layout(archiveTree(rows, 'r')), ['top', 'top/lost.png']);
});

test('entry names: no trailing dots, no slashes, no markup, null extensions dropped', () => {
  assert.equal(entryName({ filename: '888.', ext: '', filetype: 'folder' }), '888');
  assert.equal(entryName({ filename: 'a/b', ext: 'txt', filetype: 'text' }), 'a-b.txt');
  assert.equal(entryName({ filename: '<b>x</b>', ext: 'null', filetype: 'other' }), 'x');
  assert.equal(entryName({ filename: '', nid: 'n1', ext: 'pdf', filetype: 'document' }), 'n1.pdf');
});
