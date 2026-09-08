#!/usr/bin/env node

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const REPO_ROOT = join(__dirname, "..", "..");
const MEDIA_SOURCE = readFileSync(join(REPO_ROOT, "service", "media.js"), "utf8");
const DMZ_SOURCE = readFileSync(join(REPO_ROOT, "service", "dmz.js"), "utf8");
const MEDIA_ACL = JSON.parse(readFileSync(join(REPO_ROOT, "acl", "media.json"), "utf8"));

const Attr = {
  folder: "folder",
  id: "id",
  limit: "limit",
  query: "query",
  token: "token",
};

function extractAsyncMethod(source, name) {
  const start = source.indexOf(`  async ${name}(`);
  assert.notStrictEqual(start, -1, `${name} not found in media.js`);
  const end = source.indexOf("\n  }\n", start);
  assert.notStrictEqual(end, -1, `${name} has no closing brace`);
  return source
    .slice(start, end + 4)
    .replace(/^\s*async\s+/, "async function ");
}

function loadRuntime() {
  const helperStart = MEDIA_SOURCE.indexOf("const SEARCH_NAMES_DB_TIMEOUT_MS");
  const helperEnd = MEDIA_SOURCE.indexOf("class __media", helperStart);
  assert.notStrictEqual(helperStart, -1, "search-names helpers not found in media.js");
  assert.notStrictEqual(helperEnd, -1, "media class not found after search-names helpers");
  const helpers = MEDIA_SOURCE.slice(helperStart, helperEnd);
  const method = extractAsyncMethod(MEDIA_SOURCE, "search_names");

  // Compile the real production helper state and method in one closure so the
  // process-wide admission limits are exercised across multiple service stubs.
  // eslint-disable-next-line no-new-func
  return new Function(
    "Attr",
    `${helpers}\nreturn {
      acquireSearchNamesScope,
      releaseSearchNamesScope,
      runSearchNamesQuery,
      searchNamesMethod: (${method})
    };`
  )(Attr);
}

function makeDb({ rows = [], queryError, deferred } = {}) {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push({ type: "begin" }),
    query: async (options, values) => {
      calls.push({ type: "query", options, values });
      if (deferred) return deferred.promise;
      if (queryError) throw queryError;
      return rows;
    },
    commit: async () => calls.push({ type: "commit" }),
    rollback: async () => calls.push({ type: "rollback" }),
    isValid: () => true,
  };
  return {
    calls,
    db: {
      statement: (args, method) => {
        calls.push({ type: "statement", args: [...args], method });
        const name = args.shift();
        assert.strictEqual(name, "mfs_search_names");
        assert.strictEqual(method, "call");
        return "call mfs_search_names(?, ?, ?, ?)";
      },
      connection: () => connection,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeService(runtime, {
  values = { query: "report", limit: 6 },
  anonymous = false,
  userValues = {},
  uid = "user-1",
  hubId = "hub-1",
  grant = {
    id: "folder-1",
    privilege: 3,
    node: { filetype: "folder" },
  },
  dbOptions,
} = {}) {
  const database = makeDb(dbOptions);
  const calls = { errors: [], output: [] };
  const service = {
    uid,
    db: database.db,
    hub: { get: (key) => key === Attr.id ? hubId : undefined },
    input: {
      get: (key) => values[key],
      use: (key, fallback) => values[key] === undefined ? fallback : values[key],
    },
    session: { isAnonymous: () => anonymous },
    user: { get: (key) => userValues[key] },
    source_granted: () => grant,
    exception: {
      user: (code) => {
        calls.errors.push(code);
        return code;
      },
      forbiden: () => {
        calls.errors.push("FORBIDDEN");
        return "FORBIDDEN";
      },
    },
    output: {
      list: (value) => {
        calls.output.push(value);
        return value;
      },
    },
  };
  service.search_names = runtime.searchNamesMethod.bind(service);
  return { calls, database, service };
}

function searchQueries(database) {
  return database.calls.filter(({ type }) => type === "query");
}

test("ACL keeps search scoped to a read-authorized hub folder", () => {
  const entry = MEDIA_ACL.services.search_names;
  assert.ok(entry, "media.search_names ACL entry is missing");
  assert.strictEqual(entry.scope, "hub");
  assert.strictEqual(entry.permission.src, "read");
  assert.strictEqual(entry.permission.fast_check, undefined);
  assert.deepStrictEqual(entry.params.nid, {
    type: "string",
    required: true,
    doc: "Authorized folder node ID that bounds the live subtree search",
  });
  assert.strictEqual(entry.params.query.minLength, 1);
  assert.strictEqual(entry.params.query.maxLength, 128);
  assert.strictEqual(entry.params.limit.default, 6);
  assert.strictEqual(entry.params.limit.max, 6);
  assert.ok(entry.errors.some(({ code }) => code === "SEARCH_NAMES_UNSUPPORTED_CONTEXT"));
  assert.ok(entry.errors.some(({ code }) => code === "SEARCH_NAMES_BUSY"));
  assert.ok(entry.errors.some(({ code }) => code === "SEARCH_NAMES_TIMEOUT"));
  assert.ok(entry.errors.some(({ code }) => code === "SEARCH_NAMES_PROJECTION_NOT_READY"));
  assert.ok(entry.errors.some(({ code }) => code === "TREE_CYCLE"));
  assert.ok(entry.errors.some(({ code }) => code === "TREE_DEPTH_EXCEEDED"));
  assert.ok(entry.errors.some(({ code }) => code === "MENTION_PATH_TOO_LONG"));
  const fields = entry.returns.items.items.properties;
  for (const field of [
    "nid", "hub_id", "parent_id", "filename", "filetype", "ext",
    "mimetype", "capability", "area", "isalink", "mention_path",
  ]) assert.ok(fields[field], `missing response field ${field}`);
});

test("raw and durable share contexts stop before the search procedure", async () => {
  const contexts = [
    { values: { token: "raw-share-token", query: "x" } },
    { values: { mfs_token: "raw-mfs-token", query: "x" } },
    { userValues: { is_secure_share_session: 1 } },
    { userValues: { dmz_token: "legacy-token" } },
    { userValues: { is_dmz_hub_copy: "yes" } },
    { userValues: { is_dmz_hub_copy: 1 } },
    { userValues: { connection: "token" } },
  ];
  for (const options of contexts) {
    const runtime = loadRuntime();
    const { calls, database, service } = makeService(runtime, options);
    assert.strictEqual(await service.search_names(), "SEARCH_NAMES_UNSUPPORTED_CONTEXT");
    assert.deepStrictEqual(calls.errors, ["SEARCH_NAMES_UNSUPPORTED_CONTEXT"]);
    assert.strictEqual(searchQueries(database).length, 0);
  }
  assert.match(DMZ_SOURCE, /set_session_share_context/,
    "edit/member/owner secure-share sessions must retain a durable context marker");
});

test("false secure-share markers do not block an ordinary authorized session", async () => {
  for (const marker of [0, "0", false, null]) {
    const runtime = loadRuntime();
    const { calls, database, service } = makeService(runtime, {
      userValues: {
        is_secure_share_session: marker,
        is_dmz_hub_copy: marker,
      },
    });
    assert.deepStrictEqual(await service.search_names(), []);
    assert.deepStrictEqual(calls.errors, []);
    assert.strictEqual(searchQueries(database).length, 1);
  }
});

test("the authenticated actual workspace root is a valid scope", async () => {
  const runtime = loadRuntime();
  const { calls, database, service } = makeService(runtime, {
    grant: {
      id: "home-root",
      privilege: 3,
      node: {
        id: "home-root",
        actual_home_id: "home-root",
        filetype: "root",
      },
    },
  });
  assert.deepStrictEqual(await service.search_names(), []);
  assert.deepStrictEqual(calls.errors, []);
  assert.deepStrictEqual(searchQueries(database)[0].values, [
    "user-1", "home-root", "report", 6,
  ]);
});

test("anonymous, missing, non-container, foreign root, and upload-only scopes make no search call", async () => {
  const cases = [
    { anonymous: true },
    { grant: null },
    { grant: { id: "", privilege: 3, node: { filetype: "folder" } } },
    { grant: { id: "folder-1", privilege: 3 } },
    { grant: { id: "file-1", privilege: 3, node: { filetype: "document" } } },
    { grant: { id: "other-root", privilege: 3, node: { id: "other-root", actual_home_id: "home-root", filetype: "root" } } },
    { grant: { id: "folder-1", privilege: 4, node: { filetype: "folder" } } },
    { grant: { id: "folder-1", privilege: 3, node: { filetype: "folder", status: "hidden" } } },
    { grant: { id: "folder-1", privilege: 3, node: { filetype: "folder", status: "deleted" } } },
    { grant: { id: "folder-1", privilege: 3, node: { filetype: "folder", isalink: 1 } } },
    { uid: "" },
    { hubId: "" },
  ];
  for (const options of cases) {
    const runtime = loadRuntime();
    const { calls, database, service } = makeService(runtime, options);
    assert.strictEqual(await service.search_names(), "FORBIDDEN");
    assert.deepStrictEqual(calls.errors, ["FORBIDDEN"]);
    assert.strictEqual(searchQueries(database).length, 0);
  }
});

test("query normalization preserves literal wildcard characters and clamps limit", async () => {
  const runtime = loadRuntime();
  const rows = [{ nid: "file-1", filename: "%_\\ report" }];
  const wrappedRows = { get_rows: () => rows };
  const { calls, database, service } = makeService(runtime, {
    values: { nid: "client-supplied-root", query: "  %_\\   Report  ", limit: 500 },
    dbOptions: { rows: wrappedRows },
  });
  assert.deepStrictEqual(await service.search_names(), rows);
  assert.deepStrictEqual(calls.output, [rows]);
  assert.deepStrictEqual(searchQueries(database)[0].values, [
    "user-1", "folder-1", "%_\\ Report", 6,
  ]);
  assert.doesNotMatch(MEDIA_SOURCE.slice(
    MEDIA_SOURCE.indexOf("  async search_names("),
    MEDIA_SOURCE.indexOf("\n  }\n", MEDIA_SOURCE.indexOf("  async search_names("))
  ), /debug\([^\n]*query|warn\([^\n]*query/i);
});

test("one-character queries are valid and lower bounds clamp to one", async () => {
  const runtime = loadRuntime();
  const { database, service } = makeService(runtime, {
    values: { query: "a", limit: 0 },
  });
  await service.search_names();
  assert.deepStrictEqual(searchQueries(database)[0].values, [
    "user-1", "folder-1", "a", 1,
  ]);
});

test("empty, non-string, and overlong queries fail before SQL", async () => {
  for (const query of ["   ", null, 7, "x".repeat(129)]) {
    const runtime = loadRuntime();
    const { calls, database, service } = makeService(runtime, { values: { query } });
    await service.search_names();
    assert.strictEqual(searchQueries(database).length, 0);
    assert.ok(calls.errors.length, `query ${String(query)} should be rejected`);
  }
});

test("timeout helper uses a 500 ms server query option and commits normalized rows", async () => {
  const runtime = loadRuntime();
  const rows = [{ nid: "file-1" }];
  const { database } = makeService(runtime, {
    dbOptions: { rows: { get_rows: () => rows } },
  });
  assert.deepStrictEqual(await runtime.runSearchNamesQuery(database.db, [
    "user-1", "folder-1", "a", 6,
  ]), rows);
  const query = searchQueries(database)[0];
  assert.deepStrictEqual(query.options, {
    sql: "call mfs_search_names(?, ?, ?, ?)",
    timeout: 500,
    logParam: false,
  });
  assert.deepStrictEqual(query.values, ["user-1", "folder-1", "a", 6]);
  assert.deepStrictEqual(database.calls.map(({ type }) => type), [
    "statement", "begin", "query", "commit",
  ]);
});

test("query failure rolls back and rethrows without committing", async () => {
  const runtime = loadRuntime();
  const failure = Object.assign(new Error("database unavailable"), { code: "ECONNRESET" });
  const { database } = makeService(runtime, { dbOptions: { queryError: failure } });
  await assert.rejects(
    runtime.runSearchNamesQuery(database.db, ["u", "f", "q", 6]),
    (error) => error === failure
  );
  assert.deepStrictEqual(database.calls.map(({ type }) => type), [
    "statement", "begin", "query", "rollback",
  ]);
});

test("only MariaDB statement timeout errors map to SEARCH_NAMES_TIMEOUT", async () => {
  for (const timeoutError of [
    Object.assign(new Error("timeout"), { errno: 1969 }),
    Object.assign(new Error("timeout"), {
      errno: 1969,
      code: "ER_STATEMENT_TIMEOUT",
    }),
  ]) {
    const runtime = loadRuntime();
    const { calls, service } = makeService(runtime, {
      dbOptions: { queryError: timeoutError },
    });
    assert.strictEqual(await service.search_names(), "SEARCH_NAMES_TIMEOUT");
    assert.deepStrictEqual(calls.errors, ["SEARCH_NAMES_TIMEOUT"]);
    assert.strictEqual(await service.search_names(), "SEARCH_NAMES_TIMEOUT",
      "a timeout must release the per-user/hub admission slot");
  }

  for (const notReadyError of [
    Object.assign(new Error("SEARCH_NAMES_PROJECTION_NOT_READY"), {
      errno: 1644,
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "SEARCH_NAMES_PROJECTION_NOT_READY",
    }),
    Object.assign(new Error("Table 'hub.mfs_search_state' doesn't exist"), {
      errno: 1146,
      code: "ER_NO_SUCH_TABLE",
    }),
    Object.assign(new Error("PROCEDURE hub.mfs_search_names does not exist"), {
      errno: 1305,
      code: "ER_SP_DOES_NOT_EXIST",
    }),
    Object.assign(new Error("SEARCH_PROJECTION_NOT_READY"), {
      errno: 1644,
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "SEARCH_PROJECTION_NOT_READY",
    }),
    Object.assign(new Error("SEARCH_PROJECTION_DISABLED"), {
      errno: 1644,
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "SEARCH_PROJECTION_DISABLED",
    }),
    Object.assign(new Error("SEARCH_NAMES_PROJECTION_BUSY"), {
      errno: 1644,
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "SEARCH_NAMES_PROJECTION_BUSY",
    }),
  ]) {
    const runtime = loadRuntime();
    const { calls, service } = makeService(runtime, {
      dbOptions: { queryError: notReadyError },
    });
    assert.strictEqual(await service.search_names(), "SEARCH_NAMES_PROJECTION_NOT_READY");
    assert.deepStrictEqual(calls.errors, ["SEARCH_NAMES_PROJECTION_NOT_READY"]);
  }

  for (const ordinaryError of [
    Object.assign(new Error("unsupported SET STATEMENT for CALL"), { code: "ER_PARSE_ERROR" }),
    Object.assign(new Error("missing procedure"), { code: "ER_SP_DOES_NOT_EXIST" }),
    Object.assign(new Error("query interrupted"), { errno: 1317, code: "ER_QUERY_INTERRUPTED" }),
    Object.assign(new Error("uncorrelated timeout label"), { code: "ER_STATEMENT_TIMEOUT" }),
  ]) {
    const runtime = loadRuntime();
    const { calls, service } = makeService(runtime, {
      dbOptions: { queryError: ordinaryError },
    });
    await assert.rejects(service.search_names(), (error) => error === ordinaryError);
    await assert.rejects(service.search_names(), (error) => error === ordinaryError,
      "an ordinary database error must release the admission slot");
    assert.deepStrictEqual(calls.errors, []);
  }
});

test("tree and path SQL signals remain typed service errors", async () => {
  for (const [code, expected] of [
    ["TREE_CYCLE", "TREE_CYCLE"],
    ["TREE_DEPTH_EXCEEDED", "TREE_DEPTH_EXCEEDED"],
    ["MENTION_PATH_TOO_LONG", "MENTION_PATH_TOO_LONG"],
    ["SEARCH_PROJECTION_TREE_CYCLE", "TREE_CYCLE"],
    ["SEARCH_PROJECTION_DEPTH_EXCEEDED", "TREE_DEPTH_EXCEEDED"],
    ["SEARCH_PROJECTION_PATH_TOO_LONG", "MENTION_PATH_TOO_LONG"],
  ]) {
    const runtime = loadRuntime();
    const signal = Object.assign(new Error(code), {
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: code,
    });
    const { calls, service } = makeService(runtime, {
      dbOptions: { queryError: signal },
    });
    assert.strictEqual(await service.search_names(), expected);
    assert.deepStrictEqual(calls.errors, [expected]);
  }
});

test("procedure scope and query guards keep their public error boundary", async () => {
  for (const [sqlMessage, expected] of [
    ["SEARCH_NAMES_SCOPE_INVALID", "FORBIDDEN"],
    ["SEARCH_NAMES_QUERY_INVALID", "INVALID_SEARCH_QUERY"],
  ]) {
    const runtime = loadRuntime();
    const signal = Object.assign(new Error(sqlMessage), {
      code: "ER_SIGNAL_EXCEPTION",
      errno: 1644,
      sqlMessage,
    });
    const { calls, service } = makeService(runtime, {
      dbOptions: { queryError: signal },
    });
    assert.strictEqual(await service.search_names(), expected);
    assert.deepStrictEqual(calls.errors, [expected]);
  }
});

test("a second request for one user/hub is busy and the slot releases on success", async () => {
  const runtime = loadRuntime();
  const pending = deferred();
  const first = makeService(runtime, { dbOptions: { deferred: pending } });
  const second = makeService(runtime);
  const firstCall = first.service.search_names();
  await Promise.resolve();
  assert.strictEqual(await second.service.search_names(), "SEARCH_NAMES_BUSY");
  assert.strictEqual(searchQueries(second.database).length, 0);
  pending.resolve([]);
  await firstCall;
  assert.deepStrictEqual(await second.service.search_names(), []);
  assert.strictEqual(searchQueries(second.database).length, 1);
});

test("the process cap rejects request nine and releases after ordinary failure", async () => {
  const runtime = loadRuntime();
  const pending = Array.from({ length: 8 }, () => deferred());
  const active = pending.map((hold, index) => makeService(runtime, {
    uid: `user-${index}`,
    hubId: `hub-${index}`,
    dbOptions: { deferred: hold },
  }));
  const activeCalls = active.map(({ service }) => service.search_names());
  await Promise.resolve();

  const ninth = makeService(runtime, { uid: "user-9", hubId: "hub-9" });
  assert.strictEqual(await ninth.service.search_names(), "SEARCH_NAMES_BUSY");
  assert.strictEqual(searchQueries(ninth.database).length, 0);

  const ordinary = Object.assign(new Error("database failed"), { code: "ER_UNKNOWN_ERROR" });
  pending[0].reject(ordinary);
  await assert.rejects(activeCalls[0], (error) => error === ordinary);
  assert.deepStrictEqual(await ninth.service.search_names(), []);

  for (let index = 1; index < pending.length; index += 1) pending[index].resolve([]);
  await Promise.all(activeCalls.slice(1));
});
