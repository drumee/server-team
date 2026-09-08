#!/usr/bin/env node

/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

/**
 * Standalone regression coverage for chat's forward-recipient security guard.
 *
 * The production methods are lifted from chat.js and bound to a narrow service
 * stub, so the suite exercises their real control flow without MariaDB, Redis,
 * private npm packages, or network access.
 *
 * Run from server-team with:
 *   node offline/test/chat-forward-recipient-guard.test.js
 */

const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");

const {
  CAN_CHAT,
  privilegeAllows,
} = require("../../service/lib/member-capability");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const REPO_ROOT = join(__dirname, "..", "..");
const CHAT_SOURCE = readFileSync(
  join(REPO_ROOT, "service", "private", "chat.js"),
  "utf8"
);
const CHAT_ACL = JSON.parse(
  readFileSync(join(REPO_ROOT, "acl", "chat.json"), "utf8")
);

const METHOD_NAMES = [
  "_drumateFor",
  "_p2pAllowed",
  "_hubChatAllowed",
  "_sourceMemberAllowed",
  "_canChatWith",
  "forward_eligibility",
  "_distributeMessage",
  "forward",
];

function sourceConstant(name) {
  const match = CHAT_SOURCE.match(new RegExp(`^const ${name} = (.+);$`, "m"));
  assert.ok(match, `${name} not found in chat.js`);
  // The matched declarations are literals (a RegExp and a number).
  // eslint-disable-next-line no-new-func
  return new Function(`return (${match[1]});`)();
}

const ENTITY_ID_RE = sourceConstant("ENTITY_ID_RE");
const DB_NAME_RE = sourceConstant("DB_NAME_RE");
const MAX_ELIGIBILITY_HUBS = sourceConstant("MAX_ELIGIBILITY_HUBS");

function extractMethod(name) {
  const start = CHAT_SOURCE.indexOf(`  async ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in chat.js`);
  const end = CHAT_SOURCE.indexOf("\n  }\n", start);
  assert.notStrictEqual(end, -1, `${name} has no closing brace`);
  return CHAT_SOURCE
    .slice(start, end + 4)
    .replace(/^\s*async\s+/, "async function ");
}

const METHOD_BODIES = Object.fromEntries(
  METHOD_NAMES.map((name) => [name, extractMethod(name)])
);

// These dependency shims cover only the fixture shapes used below. They keep
// the standalone runner dependency-free while matching the production helpers
// for arrays, strings, plain objects, null, and scalar values.
const isArray = Array.isArray;
const isEmpty = (value) => {
  if (value == null) return true;
  if (typeof value === "string" || Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") return Object.keys(value).length === 0;
  return true;
};
const toArray = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};
const { stringify } = JSON;

const Attr = {
  entities: "entities",
  firstname: "firstname",
  nodes: "nodes",
  peer_id: "peer_id",
  socket_id: "socket_id",
};

function compileMethod(body, RedisStore) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "RedisStore",
    "Attr",
    "isEmpty",
    "isArray",
    "toArray",
    "stringify",
    "ENTITY_ID_RE",
    "DB_NAME_RE",
    "MAX_ELIGIBILITY_HUBS",
    "CAN_CHAT",
    "privilegeAllows",
    `return (${body});`
  );
  return factory(
    RedisStore,
    Attr,
    isEmpty,
    isArray,
    toArray,
    stringify,
    ENTITY_ID_RE,
    DB_NAME_RE,
    MAX_ELIGIBILITY_HUBS,
    CAN_CHAT,
    privilegeAllows
  );
}

function makeService({
  values = {},
  uid = "sender-uid",
  ypProc,
  ypFunc,
  ypQuery,
  dbProc,
} = {}) {
  const calls = {
    dbProc: [],
    redis: [],
    warnings: [],
    ypFunc: [],
    ypQuery: [],
    ypProc: [],
  };
  let output;

  const RedisStore = {
    sendData: async (payload, recipients) => {
      calls.redis.push({ payload, recipients });
    },
  };

  const service = {
    uid,
    input: {
      get: (key) => values[key],
      need: (key) => values[key],
      use: (key, fallback) => values[key] === undefined ? fallback : values[key],
    },
    output: {
      data: (value) => {
        output = value;
        return value;
      },
    },
    yp: {
      await_proc: async (name, ...args) => {
        calls.ypProc.push({ name, args });
        return ypProc ? ypProc(name, ...args) : [];
      },
      await_func: async (name, ...args) => {
        calls.ypFunc.push({ name, args });
        return ypFunc ? ypFunc(name, ...args) : null;
      },
      await_query: async (sql, ...args) => {
        calls.ypQuery.push({ sql, args });
        return ypQuery ? ypQuery(sql, ...args) : [];
      },
    },
    db: {
      await_proc: async (name, ...args) => {
        calls.dbProc.push({ name, args });
        return dbProc ? dbProc(name, ...args) : [];
      },
    },
    user: {
      get: (key) => {
        if (key === Attr.firstname) return "Sender";
        if (key === "profile") return { lastname: "User" };
        return undefined;
      },
    },
    entityInfo: async (ownerId, entityId) => ({ owner_id: ownerId, id: entityId }),
    threadInfo: async () => ({}),
    parseJSON: (value) => typeof value === "string" ? JSON.parse(value) : value,
    payload: (data, options) => ({ data, options }),
    warn: (...args) => calls.warnings.push(args),
  };

  for (const [name, body] of Object.entries(METHOD_BODIES)) {
    service[name] = compileMethod(body, RedisStore).bind(service);
  }

  return {
    calls,
    output: () => output,
    service,
  };
}

function procedureCalls(calls, procedure) {
  return calls.ypProc.filter(
    ({ name, args }) => name === "forward_proc" && args[1] === procedure
  );
}

function decodePostArgs(value) {
  const divider = value.indexOf("','", 1);
  assert.ok(value.startsWith("'") && divider > 0 && value.endsWith("'"),
    `unexpected post arguments: ${value}`);
  return {
    input: JSON.parse(value.slice(1, divider)),
    message: value.slice(divider + 3, -1),
  };
}

function decodeAttachmentArgs(value) {
  const match = /^'([^']*)','([^']*)','(.*)'$/.exec(value);
  assert.ok(match, `unexpected attachment arguments: ${value}`);
  return {
    messageId: match[1],
    recipientId: match[2],
    attachment: JSON.parse(match[3]),
  };
}

// ---------------------------------------------------------------------------
// ACL and fail-closed membership resolution
// ---------------------------------------------------------------------------

test("the ACL keeps forward write-scoped and eligibility read-scoped", () => {
  assert.strictEqual(CHAT_ACL.services.forward.permission.src, "write");
  assert.strictEqual(CHAT_ACL.services.forward_eligibility.permission.src, "read");
  assert.strictEqual(
    CHAT_ACL.services.forward_eligibility.params.hub_ids.maxItems,
    MAX_ELIGIBILITY_HUBS
  );
  assert.ok(CHAT_ACL.services.forward.errors.some(
    ({ code }) => code === "INVALID_MESSAGES"
  ));
});

test("hub chat eligibility requires an active wildcard row and the chat bit", async () => {
  const rows = {
    chat_permanent_db: [{ privilege: 7 }],
    chat_temporary_db: [{ privilege: "7" }],
    view_only_db: [{ privilege: 3 }],
    revoked_db: [],
    expired_db: [],
    missing_privilege_db: [{}],
    missing: [],
  };
  const { calls, service } = makeService({
    ypFunc: (name, hubId) => {
      assert.strictEqual(name, "get_db_name");
      if (hubId === "invalid-db") return "unsafe-db.name";
      return `${hubId.replaceAll("-", "_")}_db`;
    },
    ypQuery: (sql, uid) => {
      assert.strictEqual(uid, "sender-uid");
      assert.match(sql, /resource_id='\*' AND entity_id=\?/);
      assert.match(sql, /expiry_time=0 OR expiry_time>UNIX_TIMESTAMP\(\)/);
      const dbName = /FROM `([^`]+)`\.permission/.exec(sql)[1];
      return rows[dbName] || [];
    },
  });

  assert.strictEqual(await service._hubChatAllowed("chat-permanent"), true);
  assert.strictEqual(await service._hubChatAllowed("chat-temporary"), true);
  for (const hubId of [
    "view-only",
    "revoked",
    "expired",
    "missing-privilege",
    "missing",
    "invalid-db",
  ]) {
    assert.strictEqual(await service._hubChatAllowed(hubId), false, hubId);
  }
  assert.ok(!calls.ypQuery.some(({ sql }) => sql.includes("unsafe-db.name")));
});

test("hub lookup errors fail closed and do not escape", async () => {
  const { calls, service } = makeService({
    ypFunc: () => "hub_error_db",
    ypQuery: () => {
      throw new Error("lookup unavailable");
    },
  });

  assert.strictEqual(await service._hubChatAllowed("hub-error"), false);
  assert.strictEqual(calls.warnings.length, 1);
});

test("drumate lookup failures deny forward eligibility and abort distribution", async () => {
  const failingLookup = () => {
    throw new Error("yellow page unavailable");
  };
  const eligibility = makeService({ ypProc: failingLookup });

  assert.strictEqual(
    await eligibility.service._canChatWith("recipient", new Map(), new Map()),
    false
  );
  assert.strictEqual(eligibility.calls.warnings.length, 1);
  assert.strictEqual(eligibility.calls.ypQuery.length, 0,
    "a failed P2P classification must not fall through to a hub lookup");

  const distribution = makeService({ ypProc: failingLookup });
  await assert.rejects(
    distribution.service._distributeMessage(
      { author_id: "sender-uid", uid: "sender-uid" },
      "body",
      null,
      ["recipient"]
    ),
    /yellow page unavailable/
  );
  assert.strictEqual(procedureCalls(distribution.calls, "channel_post_message").length, 0);
  assert.ok(!distribution.calls.ypFunc.some(({ name }) => name === "uniqueId"));
});

// ---------------------------------------------------------------------------
// Batch eligibility contract
// ---------------------------------------------------------------------------

test("the raw eligibility request is capped before duplicate removal", async () => {
  const { calls, output, service } = makeService({
    values: { hub_ids: Array(51).fill("same-hub") },
  });

  await service.forward_eligibility();
  assert.deepStrictEqual(output(), { status: "INVALID_HUB_IDS" });
  assert.strictEqual(calls.ypProc.length, 0);
});

test("eligibility deduplicates lookups and maps every denied shape to zero", async () => {
  const values = {
    hub_ids: ["hub-chat", "hub-chat", "bad id", "hub-view", "hub-error"],
  };
  const { calls, output, service } = makeService({
    values,
    ypFunc: (name, hubId) => {
      assert.strictEqual(name, "get_db_name");
      return `${hubId.replaceAll("-", "_")}_db`;
    },
    ypQuery: (sql) => {
      if (sql.includes("`hub_chat_db`")) return [{ privilege: 7 }];
      if (sql.includes("`hub_view_db`")) return [{ privilege: 3 }];
      throw new Error("hidden or unavailable hub");
    },
  });

  await service.forward_eligibility();
  assert.deepStrictEqual({ ...output() }, {
    "hub-chat": 1,
    "bad id": 0,
    "hub-view": 0,
    "hub-error": 0,
  });

  const hubLookups = calls.ypFunc.filter(({ name }) => name === "get_db_name");
  assert.strictEqual(hubLookups.length, 3);
  assert.strictEqual(
    hubLookups.filter(({ args }) => args[0] === "hub-chat").length,
    1
  );
  assert.ok(!hubLookups.some(({ args }) => args[0] === "bad id"));
});

test("secure-share ceiling sessions receive only zero eligibility", async () => {
  const { calls, output, service } = makeService({
    values: { hub_ids: ["hub-a", "hub-b"], token: "secure-share-token" },
  });

  await service.forward_eligibility();
  assert.deepStrictEqual({ ...output() }, { "hub-a": 0, "hub-b": 0 });
  assert.strictEqual(calls.ypProc.length, 0);
  assert.strictEqual(calls.ypQuery.length, 0);
});

// ---------------------------------------------------------------------------
// Forward filtering and response shape
// ---------------------------------------------------------------------------

test("an all-rejected request returns before message lookup or distribution", async () => {
  const { calls, output, service } = makeService({
    values: {
      entities: ["denied-hub", "bad id", "denied-hub"],
      nodes: { hub_id: "source-hub", messages: ["source-message"] },
    },
    ypProc: (name, entityId, procedure) => {
      // Neither recipient is a person, so neither can be a member of the source
      // workspace.
      if (name === "drumate_exists") return [];
      throw new Error(`unexpected yp procedure: ${name}`);
    },
    ypFunc: (name) => {
      assert.strictEqual(name, "get_db_name");
      return "source_hub_db";
    },
    // The caller may chat in the source workspace, so the request gets as far as
    // scoring recipients.
    ypQuery: () => [{ privilege: 7 }],
    dbProc: (name) => {
      if (name === "my_contact_exists") return [];
      throw new Error(`message distribution must not call ${name}`);
    },
  });

  await service.forward();
  assert.deepStrictEqual(output(), {
    status: "INVALID_RECIPIENT",
    rejected: ["bad id", "denied-hub"],
  });
  assert.strictEqual(
    calls.ypProc.filter(({ name }) => name === "drumate_exists").length,
    1,
    "the duplicate recipient must be evaluated once"
  );
  assert.ok(!calls.ypFunc.some(({ name }) => name === "uniqueId"),
    "no message ID may be minted");
  assert.strictEqual(calls.redis.length, 0, "no socket payload may be sent");
  assert.ok(!calls.dbProc.some(({ name }) => name === "forward_message_get"));
});

test("a formal contact is cached as P2P before distribution", async () => {
  let distributed = false;
  const { calls, output, service } = makeService({
    values: {
      entities: ["formal-contact"],
      // A P2P source (nodes.hub_id === the caller's own uid) is the only context
      // where the contact-or-drumate policy still decides. Out of a workspace
      // conversation a formal contact who is not a member of that workspace is
      // refused — see the source-confinement tests below.
      nodes: { hub_id: "sender-uid", messages: ["source-message"] },
      peer_id: "formal-contact",
    },
    ypProc: (name) => {
      if (name === "drumate_exists") return [];
      throw new Error(`formal contacts must not fall through to ${name}`);
    },
    dbProc: (name, kind, entityId) => {
      if (name === "my_contact_exists") {
        assert.strictEqual(kind, "entity");
        return { uid: entityId };
      }
      if (name === "p2p_get_message") {
        return { message: "Forward body" };
      }
      throw new Error(`unexpected db procedure: ${name}`);
    },
  });
  service._distributeMessage = async (input, message, threadId, entities, drumateCache) => {
    distributed = true;
    assert.deepStrictEqual(entities, ["formal-contact"]);
    const classification = drumateCache.get("formal-contact");
    assert.ok(classification, "formal contact must have a non-empty P2P classification");
    assert.strictEqual(classification.id, "formal-contact");
    assert.strictEqual(
      await service._drumateFor("formal-contact", drumateCache),
      classification,
      "distribution must reuse the request-local classification"
    );
    return [{ message_id: "forwarded-message", entity_id: "formal-contact" }];
  };

  await service.forward();
  assert.strictEqual(distributed, true);
  assert.ok(Array.isArray(output()));
  assert.strictEqual(
    calls.ypProc.filter(({ name }) => name === "drumate_exists").length,
    1,
    "the empty yellow-page lookup must not be repeated during distribution"
  );
  assert.strictEqual(procedureCalls(calls, "member_show_privilege").length, 0,
    "a formal contact must not be reclassified as a hub"
  );
});

test("a mixed result stays an array and adds rejected metadata only to the response", async () => {
  const distributed = [
    { message_id: "message-1", entity_id: "allowed-user" },
    { message_id: "message-1", to_id: "allowed-user" },
  ];
  let distributedEntities;
  const { output, service } = makeService({
    values: {
      entities: ["allowed-user", "allowed-user", "denied-hub", "bad id"],
      nodes: { hub_id: "source-hub", messages: ["source-message"] },
    },
    ypProc: (name, entityId, procedure) => {
      // Only `allowed-user` is a person; `denied-hub` is a hub, which can never
      // be a member of the source workspace.
      if (name === "drumate_exists") {
        return entityId === "allowed-user" ? { id: entityId } : [];
      }
      return [];
    },
    ypFunc: (name) => {
      assert.strictEqual(name, "get_db_name");
      return "source_hub_db";
    },
    // The caller and `allowed-user` both hold a chat row in the source
    // workspace; every other lookup falls through to no row.
    ypQuery: (sql, entityId) =>
      entityId === "sender-uid" || entityId === "allowed-user"
        ? [{ privilege: 7 }]
        : [],
    dbProc: (name) => {
      if (name === "my_contact_exists") return [];
      if (name === "forward_message_get") {
        return { result: JSON.stringify([JSON.stringify({ message: "Forward body" })]) };
      }
      throw new Error(`unexpected db procedure: ${name}`);
    },
  });
  service._distributeMessage = async (input, message, threadId, entities) => {
    assert.strictEqual(message, "Forward body");
    assert.strictEqual(threadId, null);
    distributedEntities = entities;
    return distributed;
  };

  await service.forward();
  const result = output();
  assert.ok(Array.isArray(result), "mixed forward output must remain a top-level array");
  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(distributedEntities, ["allowed-user"]);
  assert.deepStrictEqual(result[0].rejected, ["bad id", "denied-hub"]);
  assert.strictEqual(result.rejected, undefined,
    "rejected metadata must not be attached as a named Array property");
  assert.strictEqual(result[1].rejected, undefined);
  assert.strictEqual(distributed[0].rejected, undefined,
    "the already-distributed message object must not be mutated");
  assert.notStrictEqual(result[0], distributed[0],
    "response metadata belongs on a shallow response copy");
});

test("missing source messages return an error before distribution", async () => {
  const { output, service } = makeService({
    values: {
      entities: ["allowed-user", "denied-hub"],
      nodes: { hub_id: "source-hub", messages: ["deleted-message"] },
    },
    ypProc: (name, entityId) => {
      if (name === "drumate_exists") {
        return entityId === "allowed-user" ? { id: entityId } : [];
      }
      throw new Error(`unexpected yp procedure: ${name}`);
    },
    ypFunc: () => "source_hub_db",
    ypQuery: (sql, entityId) =>
      entityId === "sender-uid" || entityId === "allowed-user"
        ? [{ privilege: 7 }]
        : [],
    dbProc: (name) => {
      if (name === "my_contact_exists") return [];
      if (name === "forward_message_get") {
        return { result: JSON.stringify([]) };
      }
      throw new Error(`unexpected db procedure: ${name}`);
    },
  });
  service._distributeMessage = async () => {
    throw new Error("distribution must not run without a source message");
  };

  await service.forward();

  assert.deepStrictEqual(output(), {
    status: "INVALID_MESSAGES",
    rejected: ["denied-hub"],
  });
});

// ---------------------------------------------------------------------------
// Source-workspace confinement
// ---------------------------------------------------------------------------

// A workspace conversation may only be relayed to that workspace's own CHAT
// members. Recipient shapes, and why each verdict holds:
//
//   member-chat   person, chat row in the source hub        -> allowed
//   member-view   person, view-only row in the source hub   -> refused
//   outsider      person, no row in the source hub          -> refused
//   source-hub    the source workspace itself               -> allowed
//   other-hub     another hub the caller may chat in        -> refused
//
// member-view is refused on purpose (QA decision 2026-08-15): a view-only
// member has no access to that workspace's conversation, so handing them one of
// its messages would grant what the workspace never did. `other-hub` is the case
// the confinement rule exists for — the caller's own right there is irrelevant,
// because forwarding to it would move the message out of the workspace it was
// written in.
function makeConfinedForward(entities, overrides = {}) {
  const members = { "member-chat": 7, "member-view": 3, "sender-uid": 7 };
  return makeService({
    values: {
      entities,
      nodes: { hub_id: "source-hub", messages: ["source-message"] },
    },
    ypProc: (name, entityId) => {
      if (name !== "drumate_exists") return [];
      // Hubs have no yellow-page drumate row; people do.
      return entityId === "source-hub" || entityId === "other-hub"
        ? []
        : { id: entityId };
    },
    ypFunc: (name, hubId) => `${String(hubId).replaceAll("-", "_")}_db`,
    ypQuery: (sql, entityId) => {
      // Only the source hub's own membership table is ever consulted; any read
      // against another hub's table would itself be the leak.
      assert.match(sql, /FROM `source_hub_db`\.permission/);
      const privilege = members[entityId];
      return privilege == null ? [] : [{ privilege }];
    },
    dbProc: (name) => {
      if (name === "my_contact_exists") return [];
      if (name === "forward_message_get") {
        return { result: JSON.stringify([JSON.stringify({ message: "Body" })]) };
      }
      throw new Error(`unexpected db procedure: ${name}`);
    },
    ...overrides,
  });
}

test("a workspace message reaches only that workspace's chat members", async () => {
  const { output, service } = makeConfinedForward([
    "member-chat",
    "member-view",
    "outsider",
    "other-hub",
    "source-hub",
  ]);
  let distributedEntities;
  service._distributeMessage = async (input, message, threadId, entities) => {
    distributedEntities = entities;
    return [{ message_id: "forwarded" }];
  };

  await service.forward();

  assert.deepStrictEqual(distributedEntities, ["member-chat", "source-hub"]);
  assert.deepStrictEqual(output()[0].rejected, [
    "member-view",
    "outsider",
    "other-hub",
  ]);
});

test("both sides of a forward need the chat right, not mere membership", async () => {
  // Held to ONE bar on purpose. `privilegeAllows` is (p & bit) === bit, and the
  // view role (0b000011) shares the read bit with every other role — so gating
  // on anything but the download/chat bit silently admits exactly the role this
  // test exists to exclude (see member-capability.js).
  const { calls, output, service } = makeConfinedForward(["member-chat"], {
    ypQuery: (sql, entityId) =>
      entityId === "sender-uid" ? [{ privilege: 3 }] : [{ privilege: 7 }],
  });
  service._distributeMessage = async () => {
    throw new Error("a view-only caller must not reach distribution");
  };

  await service.forward();

  assert.deepStrictEqual(output(), { status: "INVALID_SOURCE", rejected: [] });
  assert.ok(!calls.dbProc.some(({ name }) => name === "forward_message_get"));

  // The recipient side of the same bar: a view-only member is refused even when
  // the caller may chat, and the message is never distributed to anyone.
  const member = makeConfinedForward(["member-view"]);
  member.service._distributeMessage = async () => {
    throw new Error("a view-only recipient must not be distributed to");
  };

  await member.service.forward();
  assert.deepStrictEqual(member.output(), {
    status: "INVALID_RECIPIENT",
    rejected: ["member-view"],
  });
});

test("a non-member cannot relay a workspace message at all", async () => {
  // forward_message_get resolves the hub DB from the client-supplied hub_id
  // without checking the reader, so the caller's own access to the source room
  // has to be established here or a non-member could forward its messages.
  const { calls, output, service } = makeConfinedForward(["member-chat"], {
    ypQuery: () => [],
  });
  service._distributeMessage = async () => {
    throw new Error("a non-member must not reach distribution");
  };

  await service.forward();

  assert.deepStrictEqual(output(), { status: "INVALID_SOURCE", rejected: [] });
  assert.ok(!calls.dbProc.some(({ name }) => name === "forward_message_get"),
    "the source message must not even be read");
  assert.strictEqual(calls.redis.length, 0);
});

test("claiming P2P for a workspace message finds no message to forward", async () => {
  // nodes.hub_id is client-supplied, so a caller can claim the P2P path to skip
  // the confinement rule. It gains nothing: the P2P path reads p2p_channel in a
  // drumate DB, where a workspace message does not exist.
  const { output, service } = makeService({
    values: {
      entities: ["outsider"],
      nodes: { hub_id: "sender-uid", messages: ["workspace-message"] },
    },
    ypProc: (name, entityId) =>
      name === "drumate_exists" ? { id: entityId } : [],
    dbProc: (name) => {
      if (name === "p2p_get_message") return [];
      if (name === "my_contact_exists") return [];
      throw new Error(`unexpected db procedure: ${name}`);
    },
  });
  service._distributeMessage = async () => {
    throw new Error("distribution must not run without a source message");
  };

  await service.forward();

  assert.deepStrictEqual(output(), {
    status: "INVALID_MESSAGES",
    rejected: [],
  });
});

test("eligibility scores recipients against the source workspace", async () => {
  const members = { "member-chat": 7, "member-view": 3, "sender-uid": 7 };
  const { output, service } = makeService({
    values: {
      hub_ids: ["member-chat", "member-view", "outsider", "other-hub", "source-hub"],
      source_hub_id: "source-hub",
    },
    ypProc: (name, entityId) => {
      if (name !== "drumate_exists") return [];
      return entityId === "source-hub" || entityId === "other-hub"
        ? []
        : { id: entityId };
    },
    ypFunc: (name, hubId) => `${String(hubId).replaceAll("-", "_")}_db`,
    ypQuery: (sql, entityId) => {
      assert.match(sql, /FROM `source_hub_db`\.permission/);
      const privilege = members[entityId];
      return privilege == null ? [] : [{ privilege }];
    },
  });

  await service.forward_eligibility();

  // The picker must grey out a view-only member exactly as forward() refuses
  // them — a row scored 1 here but rejected there is a selectable dead end.
  assert.deepStrictEqual({ ...output() }, {
    "member-chat": 1,
    "member-view": 0,
    outsider: 0,
    "other-hub": 0,
    "source-hub": 1,
  });
});

test("eligibility hides every row when the caller may not chat in the source", async () => {
  const { calls, output, service } = makeService({
    values: {
      hub_ids: ["member-chat", "source-hub"],
      source_hub_id: "source-hub",
    },
    ypFunc: () => "source_hub_db",
    ypQuery: () => [],
  });

  await service.forward_eligibility();

  assert.deepStrictEqual({ ...output() }, { "member-chat": 0, "source-hub": 0 });
  assert.strictEqual(calls.ypProc.length, 0,
    "no recipient may be classified once the source is refused");
});

test("a malformed source workspace id is refused outright", async () => {
  const { calls, output, service } = makeService({
    values: { hub_ids: ["member-chat"], source_hub_id: "bad id" },
  });

  await service.forward_eligibility();

  assert.deepStrictEqual(output(), { status: "INVALID_HUB_IDS" });
  assert.strictEqual(calls.ypQuery.length, 0);
});

// ---------------------------------------------------------------------------
// Per-recipient message and attachment writes
// ---------------------------------------------------------------------------

test("P2P forwarding mints and pairs one message ID per attachment recipient", async () => {
  let nextId = 0;
  const input = {
    author_id: "sender-uid",
    uid: "sender-uid",
    attachment: [{ nid: "file-1" }],
  };
  const originalInput = JSON.parse(JSON.stringify(input));
  const { calls, service } = makeService({
    ypFunc: (name) => {
      assert.strictEqual(name, "uniqueId");
      nextId += 1;
      return `p2p-message-${nextId}`;
    },
    ypProc: (name, ...args) => {
      if (name === "drumate_exists") return { id: args[0] };
      if (name === "user_sockets") return [];
      if (name !== "forward_proc") {
        throw new Error(`unexpected yp procedure: ${name}`);
      }
      const [, procedure, encoded] = args;
      if (procedure === "p2p_post_message") {
        const posted = decodePostArgs(encoded);
        return { message_id: posted.input.message_id, mention_ids: "[]" };
      }
      if (procedure === "channel_post_attachment") return {};
      if (procedure === "count_yet_read_next") return { room: 0, total: 0 };
      throw new Error(`unexpected forwarded procedure: ${procedure}`);
    },
  });

  await service._distributeMessage(
    input,
    "Forward body",
    null,
    ["peer-a", "peer-b"]
  );

  assert.deepStrictEqual(input, originalInput, "the shared input must remain immutable");
  assert.strictEqual(calls.ypFunc.length, 2);

  const posts = procedureCalls(calls, "p2p_post_message").map(({ args }) => ({
    target: args[0],
    ...decodePostArgs(args[2]),
  }));
  assert.deepStrictEqual(posts.map(({ target, input: entityInput, message }) => ({
    target,
    entity_id: entityInput.entity_id,
    peer_id: entityInput.peer_id,
    message_id: entityInput.message_id,
    message,
  })), [
    {
      target: "sender-uid",
      entity_id: "peer-a",
      peer_id: "peer-a",
      message_id: "p2p-message-1",
      message: "Forward body",
    },
    {
      target: "sender-uid",
      entity_id: "peer-b",
      peer_id: "peer-b",
      message_id: "p2p-message-2",
      message: "Forward body",
    },
  ]);

  const attachments = procedureCalls(calls, "channel_post_attachment")
    .map(({ args }) => ({ target: args[0], ...decodeAttachmentArgs(args[2]) }));
  assert.deepStrictEqual(attachments, [
    {
      target: "sender-uid",
      messageId: "p2p-message-1",
      recipientId: "peer-a",
      attachment: [{ nid: "file-1" }],
    },
    {
      target: "sender-uid",
      messageId: "p2p-message-2",
      recipientId: "peer-b",
      attachment: [{ nid: "file-1" }],
    },
  ]);
});

test("hub forwarding uses the message parameter and pairs IDs to each hub", async () => {
  let nextId = 0;
  const input = {
    author_id: "sender-uid",
    uid: "sender-uid",
    attachment: [{ nid: "file-2" }],
  };
  const { calls, service } = makeService({
    ypFunc: () => {
      nextId += 1;
      return `hub-message-${nextId}`;
    },
    ypProc: (name, ...args) => {
      if (name === "drumate_exists") return [];
      if (name === "entity_sockets") return [];
      if (name !== "forward_proc") {
        throw new Error(`unexpected yp procedure: ${name}`);
      }
      const [, procedure, encoded] = args;
      if (procedure === "channel_post_message") {
        const posted = decodePostArgs(encoded);
        return { message_id: posted.input.message_id };
      }
      if (procedure === "channel_post_attachment") return {};
      throw new Error(`unexpected forwarded procedure: ${procedure}`);
    },
  });

  await service._distributeMessage(
    input,
    "Hub forward body",
    null,
    ["hub-a", "hub-b"]
  );

  const posts = procedureCalls(calls, "channel_post_message").map(({ args }) => ({
    target: args[0],
    ...decodePostArgs(args[2]),
  }));
  assert.deepStrictEqual(posts.map(({ target, input: entityInput, message }) => ({
    target,
    entity_id: entityInput.entity_id,
    message_id: entityInput.message_id,
    message,
  })), [
    {
      target: "hub-a",
      entity_id: "hub-a",
      message_id: "hub-message-1",
      message: "Hub forward body",
    },
    {
      target: "hub-b",
      entity_id: "hub-b",
      message_id: "hub-message-2",
      message: "Hub forward body",
    },
  ]);

  const attachments = procedureCalls(calls, "channel_post_attachment")
    .map(({ args }) => ({ target: args[0], ...decodeAttachmentArgs(args[2]) }));
  assert.deepStrictEqual(attachments, [
    {
      target: "hub-a",
      messageId: "hub-message-1",
      recipientId: "hub-a",
      attachment: [{ nid: "file-2" }],
    },
    {
      target: "hub-b",
      messageId: "hub-message-2",
      recipientId: "hub-b",
      attachment: [{ nid: "file-2" }],
    },
  ]);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL - ${name}`);
      console.error(`         ${error && error.stack ? error.stack : error}`);
    }
  }

  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
