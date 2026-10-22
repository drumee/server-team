#!/usr/bin/env node
//
// activity-chat-topic.test.js — folder-chat rollups name the topic of their
// latest message.
//
//   node offline/test/activity-chat-topic.test.js
//
// A folder chat opens on # General, which leaves topic messages out, and the
// teamchat rollup is per FOLDER — so "<A> sent a message" for a message posted
// in a topic opened a chat that did not show it. `_stampChatTopics` stamps
// `topic_id` ("general" outside any topic) so the client can scope the chat.
//
// It runs the REAL method, sliced out of service/private/activity.js and
// evaluated against a stubbed `yp`. What matters:
//   * the topic of the message the rollup's last_id names, nothing else;
//   * one list per distinct hub, not one per row;
//   * any lookup that fails or misses leaves the row as it was (no topic_id),
//     so it opens exactly as before.
//
// Exit code 0 = all pass, 1 = any failure.

const { readFileSync } = require('fs');
const { join } = require('path');

const SRC = join(__dirname, '../../service/private/activity.js');
const src = readFileSync(SRC, 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${msg}`);
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function sliceMethod(name) {
  const start = src.indexOf(`  async ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${SRC}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const toArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const { sqlString } = require('../../service/lib/sql-literal');

// lists: hub -> rows of channel_list_notifications | 'THROW'
// messages: message_id -> channel_get row | 'THROW'
const Topics = new Function(
  'toArray', 'sqlString',
  `class T {
     constructor(lists, messages) {
       this.uid = 'me';
       this.calls = [];
       this.debugs = [];
       const self = this;
       this.yp = { async await_proc(proc, hub, fn, args) {
         self.calls.push({ hub, fn, args });
         if (fn === 'channel_list_notifications') {
           if (lists[hub] === 'THROW') throw new Error('boom');
           return lists[hub] || [];
         }
         const id = String(args).replace(/'/g, '');
         if (messages[id] === 'THROW') throw new Error('boom');
         return messages[id] || [];
       } };
     }
     debug(...a) { this.debugs.push(a); }
     ${sliceMethod('_stampChatTopics')}
   }
   return T;`,
)(toArray, sqlString);

(async () => {
  {
    const t = new Topics(
      { h1: [{ sys_id: 30, message_id: 'm30' }, { sys_id: 20, message_id: 'm20' }, { sys_id: 10, message_id: 'm10' }] },
      {
        m30: { message_id: 'm30', topic_id: 'tp1' },
        // an older hub without the virtual column: topic read from metadata
        m20: { message_id: 'm20', metadata: JSON.stringify({ _scope_nid: 'f2', _topic_id: 'tp2' }) },
        m10: { message_id: 'm10', topic_id: null, metadata: '{"_scope_nid":"f3"}' },
      },
    );
    const rows = [
      { category: 'teamchat', hub_id: 'h1', nid: 'f1', last_id: 30 },
      { category: 'teamchat', hub_id: 'h1', nid: 'f2', last_id: '20' },
      { category: 'teamchat', hub_id: 'h1', nid: 'f3', last_id: 10 },
      { category: 'teamchat', hub_id: 'h1', nid: 'f4', last_id: 99 },
      { category: 'media', hub_id: 'h1', nid: 'f1', last_id: 30 },
      { category: 'chat', drumate_id: 'p1', last_id: 30 },
    ];
    await t._stampChatTopics(rows);
    eq(rows[0].topic_id, 'tp1', 'topic from the topic_id column');
    eq(rows[1].topic_id, 'tp2', 'topic from metadata._topic_id when the column is absent');
    eq(rows[2].topic_id, 'general', 'a message outside any topic → general');
    eq(rows[3].topic_id, undefined, 'last_id not in the list → left untouched');
    eq(rows[4].topic_id, undefined, 'media rollup untouched');
    eq(rows[5].topic_id, undefined, 'p2p chat rollup untouched');
    eq(t.calls.filter((c) => c.fn === 'channel_list_notifications').length, 1, 'one list per hub');
    eq(t.calls.filter((c) => c.fn === 'channel_get').length, 3, 'one channel_get per matched row');
    const list = t.calls.find((c) => c.fn === 'channel_list_notifications');
    eq(list.args, `'me','all',0,1`, 'list reads read AND unread messages of the caller');
  }

  {
    // failures are contained: a throwing hub list, a throwing channel_get
    const t = new Topics(
      { bad: 'THROW', h2: [{ sys_id: 5, message_id: 'm5' }, { sys_id: 6, message_id: 'm6' }] },
      { m5: 'THROW', m6: { topic_id: 'tp6' } },
    );
    const rows = [
      { category: 'teamchat', hub_id: 'bad', nid: 'f1', last_id: 1 },
      { category: 'teamchat', hub_id: 'h2', nid: 'f1', last_id: 5 },
      { category: 'teamchat', hub_id: 'h2', nid: 'f2', last_id: 6 },
    ];
    let threw = false;
    try { await t._stampChatTopics(rows); } catch (e) { threw = true; }
    ok(!threw, 'a failing lookup never throws');
    eq(rows[0].topic_id, undefined, 'hub list failure → row untouched');
    eq(rows[1].topic_id, undefined, 'channel_get failure → row untouched');
    eq(rows[2].topic_id, 'tp6', 'the other row of the hub still resolves');
  }

  {
    // "mentioned you in": the topic of the MENTION, not of the newest message.
    // A hub whose rows are all named by their mention needs no list.
    const t = new Topics(
      { h1: [{ sys_id: 50, message_id: 'm50' }], h2: 'THROW' },
      {
        m50: { topic_id: null },          // newest message: General
        mA: { topic_id: 'tpA' },          // the mention: topic A
        mB: { metadata: '{"_topic_id":"tpB"}' },
      },
    );
    const rows = [
      { category: 'teamchat', hub_id: 'h1', nid: 'f1', last_id: 50, mentioned_in: 'F1', mention_message_id: 'mA' },
      { category: 'teamchat', hub_id: 'h1', nid: 'f2', last_id: 50 },
      { category: 'teamchat', hub_id: 'h2', nid: 'f3', last_id: 9, mentioned_in: 'F3', mention_message_id: 'mB' },
    ];
    await t._stampChatTopics(rows);
    eq(rows[0].topic_id, 'tpA', 'mention row opens the topic of the mention');
    eq(rows[1].topic_id, 'general', 'plain row still follows last_id');
    eq(rows[2].topic_id, 'tpB', 'mention row resolves even when its hub has no list');
    eq(t.calls.filter((c) => c.fn === 'channel_list_notifications' && c.hub === 'h2').length, 0,
      'no list for a hub whose rows are all named by their mention');
  }

  {
    // nothing to do → no DB call at all; an existing topic_id is kept
    const t = new Topics({}, {});
    await t._stampChatTopics([]);
    await t._stampChatTopics([{ category: 'teamchat', hub_id: 'h1', last_id: 0 }]);
    const kept = [{ category: 'teamchat', hub_id: 'h1', last_id: 3, topic_id: 'x' }];
    await t._stampChatTopics(kept);
    eq(t.calls.length, 0, 'no rows to stamp → no DB call');
    eq(kept[0].topic_id, 'x', 'an existing topic_id is kept');
  }

  {
    // caps: at most 8 hubs listed
    const lists = {};
    const rows = [];
    for (let i = 0; i < 12; i++) {
      lists[`h${i}`] = [{ sys_id: 1, message_id: `m${i}` }];
      rows.push({ category: 'teamchat', hub_id: `h${i}`, nid: 'f', last_id: 1 });
    }
    const messages = {};
    for (let i = 0; i < 12; i++) messages[`m${i}`] = { topic_id: null };
    const t = new Topics(lists, messages);
    await t._stampChatTopics(rows);
    eq(t.calls.filter((c) => c.fn === 'channel_list_notifications').length, 8, 'hub lookups capped at 8');
    eq(rows.filter((r) => r.topic_id === 'general').length, 8, 'rows of capped-out hubs untouched');
  }

  {
    // _stampChatMentions names the NEWEST unread mention of each folder
    // (channel_list_notifications lists newest first).
    const Mentions = new Function(
      'toArray', 'sqlString',
      `class M {
         constructor(perHub) {
           this.uid = 'me';
           this.calls = [];
           this.yp = { async await_proc(proc, hub) { return perHub[hub] || []; } };
         }
         debug() {}
         ${sliceMethod('_stampChatMentions')}
       }
       return M;`,
    )(toArray, sqlString);
    const m = new Mentions({
      h1: [
        { scope_nid: 'f1', message_id: 'newest' },
        { scope_nid: 'f1', message_id: 'older' },
        { scope_nid: 'null', message_id: 'hubLevel' },
      ],
    });
    const rows = [
      { category: 'teamchat', hub_id: 'h1', nid: 'f1', filename: 'F1' },
      { category: 'teamchat', hub_id: 'h1', nid: null, filename: 'WS' },
      { category: 'teamchat', hub_id: 'h1', nid: 'f2', filename: 'F2' },
    ];
    await m._stampChatMentions(rows);
    eq(rows[0].mention_message_id, 'newest', 'newest mention of the folder');
    eq(rows[1].mention_message_id, 'hubLevel', 'hub-level mention');
    eq(rows[2].mention_message_id, undefined, 'no mention → no id');
    eq(rows[2].mentioned_in, undefined, 'no mention → not flagged');
  }

  console.log(`activity-chat-topic: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
