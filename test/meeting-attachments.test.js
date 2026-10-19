/**
 * Cover for service/lib/meeting-attachments — the nid list a meeting node
 * keeps in metadata.content.attachments.
 * Run: node test/meeting-attachments.test.js
 */
const assert = require("assert");
const m = require("../service/lib/meeting-attachments");

const A = "0123456789abcdef", B = "fedcba9876543210", C = "00000000000000aa";

// normalizeNids: shapes, validation, order, dedupe
assert.deepStrictEqual(m.normalizeNids([A, B, A]), [A, B]);
assert.deepStrictEqual(m.normalizeNids(JSON.stringify([B, A])), [B, A]);
assert.deepStrictEqual(m.normalizeNids(A), [A]);
assert.deepStrictEqual(m.normalizeNids(["x'); DROP", A.toUpperCase(), null, 5, A]), [A]);
assert.deepStrictEqual(m.normalizeNids(undefined), []);
assert.deepStrictEqual(m.normalizeNids("not json ["), []);

// attachmentsOf: object or JSON content, missing field
assert.deepStrictEqual(m.attachmentsOf({ attachments: [A] }), [A]);
assert.deepStrictEqual(m.attachmentsOf(JSON.stringify({ attachments: [B] })), [B]);
assert.deepStrictEqual(m.attachmentsOf({ title: "x" }), []);
assert.deepStrictEqual(m.attachmentsOf(null), []);

// mergeAttachments: append, skip existing, cap
assert.deepStrictEqual(m.mergeAttachments([A], [A, B]), { list: [A, B], added: [B], overflow: [] });
const many = Array.from({ length: m.MAX_ATTACHMENTS }, (_, i) => i.toString(16).padStart(16, "0"));
const r = m.mergeAttachments(many, [C]);
assert.strictEqual(r.list.length, m.MAX_ATTACHMENTS);
assert.deepStrictEqual(r.added, []);
assert.deepStrictEqual(r.overflow, [C]);

// isMeetingNode
assert.strictEqual(m.isMeetingNode({ filetype: "schedule" }), true);
assert.strictEqual(m.isMeetingNode({ category: "schedule" }), true);
assert.strictEqual(m.isMeetingNode({ filetype: "folder" }), false);
assert.strictEqual(m.isMeetingNode(null), false);

console.log("meeting-attachments: ok");
