/**
 * Cover for service/lib/meeting-card-push — who receives a channel.post push.
 *
 * A normal chat post skips the sender's socket: widget_chat already drew the
 * row locally and matches the echo. A meeting card is posted by window_meeting,
 * which draws nothing, so skipping the sender left the host's own folder chat
 * and meeting chat without the card, and the later channel.meeting_end found
 * no row to flip.
 *
 * Run: node test/meeting-card-push.test.js
 */
const assert = require("assert");
const { meetingCardAction, pushExclude } = require("../service/lib/meeting-card-push");

const card = (action) => `[[MEETING:${action}:{"hub_id":"h","nid":"n"}]]`;

// meetingCardAction reads the sentinel, nothing else.
assert.strictEqual(meetingCardAction(card("start")), "start");
assert.strictEqual(meetingCardAction(card("end")), "end");
assert.strictEqual(meetingCardAction("[[MEETING: start :{}]]"), "start");
assert.strictEqual(meetingCardAction("hello"), null);
assert.strictEqual(meetingCardAction("see [[MEETING:start:{}]]"), null);
assert.strictEqual(meetingCardAction(undefined), null);
assert.strictEqual(meetingCardAction(null), null);

// A chat message keeps excluding the sender.
assert.deepStrictEqual(pushExclude("hello", ["sock1"]), ["sock1"]);
assert.strictEqual(pushExclude("hello", undefined), undefined);

// A meeting card reaches the sender's own tab too.
assert.strictEqual(pushExclude(card("start"), ["sock1"]), undefined);
assert.strictEqual(pushExclude(card("end"), ["sock1"]), undefined);

console.log("meeting-card-push: ok");
