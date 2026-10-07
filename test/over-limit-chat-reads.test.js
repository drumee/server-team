// The over-limit read-only clamp (router/rest/index.js) lets a locked org READ
// its direct chats, and still refuses every chat write.
//
// The clamp decides on `permission.src > read`, and acl/chat.json declares
// every direct-chat method src:'write' — reads included — so before these were
// allowlisted the owner of a locked org got 401 OVER_LIMIT_READ_ONLY on the
// conversation list and the unread counts (measured on the aaron endpoint,
// 2026-10-07). The router cannot be required outside the runtime, so — like
// offline/test/hub-delete-permission.test.js — this reads its source.
//
//   node --test test/over-limit-chat-reads.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const CHAT = JSON.parse(readFileSync(join(ROOT, 'acl', 'chat.json'), 'utf8')).services;

function clampAllowlist() {
  const src = readFileSync(join(ROOT, 'router', 'rest', 'index.js'), 'utf8');
  const block = /const OVER_LIMIT_MUTATING_ALLOWLIST = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(block, 'OVER_LIMIT_MUTATING_ALLOWLIST not found in router/rest/index.js');
  const code = block[1].replace(/\/\/.*$/gm, '');
  return new Set([...code.matchAll(/"([^"]+)"/g)].map(match => match[1]));
}

const READS = ['chat_rooms', 'contact_rooms', 'share_rooms', 'chat_room_info', 'tag_chat_count', 'count_all', 'messages'];
const WRITES = ['post', 'forward', 'react', 'delete', 'acknowledge', 'upload_remove', 'change_status'];

test('the direct-chat reads survive the clamp', () => {
  const allowed = clampAllowlist();
  for (const method of READS) {
    assert.ok(CHAT[method], `chat.${method} is not in acl/chat.json`);
    assert.ok(allowed.has(`chat.${method}`), `chat.${method} is still clamped for a locked org`);
  }
});

test('every direct-chat write stays clamped', () => {
  const allowed = clampAllowlist();
  for (const method of WRITES) {
    assert.ok(CHAT[method], `chat.${method} is not in acl/chat.json`);
    assert.notEqual(CHAT[method].permission.src, 'read', `chat.${method} would pass the clamp on its own`);
    assert.ok(!allowed.has(`chat.${method}`), `chat.${method} escapes the clamp`);
  }
});
