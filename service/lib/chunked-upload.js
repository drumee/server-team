/**
 * Chunked, resumable upload sessions (media.upload_init / upload_chunk /
 * upload_status / upload_complete / upload_abort).
 *
 * A plain media.upload rides one request for the whole file: on a slow link a
 * multi-GB file is a multi-hour request that restarts from zero on any network
 * blip. Here the browser cuts the file into CHUNK_SIZE pieces and sends them
 * as independent small requests (in parallel, each with its own retries). The
 * server keeps the session in Redis and the bytes in ONE preallocated sparse
 * file under <tmp_dir>/chunked/, writing every chunk at its own offset, so
 * chunks can land in any order and a session survives a page reload: the
 * client asks upload_status which chunks are already there and sends only the
 * missing ones. upload_complete hands the assembled file to the very same
 * store() a normal upload ends in, so quota, changelog, live update and
 * indexing behave exactly like a single-request upload.
 *
 * Redis layout (node-redis v4+ API):
 *   upload:session:<id>  hash  {upload_id, uid, hub_id, nid, filename, filesize,
 *                               chunk_size, total, path, replace, ownpath, ctime}
 *   upload:chunks:<id>   set   indices already written
 * Both keys carry SESSION_TTL, refreshed on every chunk.
 */
const { join, extname } = require("node:path");
const { mkdirSync, createReadStream, createWriteStream } = require("node:fs");
const { open, stat, unlink, readdir } = require("node:fs/promises");
const { RedisStore, sysEnv } = require("@drumee/server-essentials");

const { tmp_dir } = sysEnv();

const CHUNK_SIZE = 16 * 1024 * 1024;
const SESSION_TTL = 48 * 3600; // seconds
const DIRNAME = "chunked";
const SESSION_KEY = "upload:session:";
const CHUNKS_KEY = "upload:chunks:";
const SWEEP_EVERY_MS = 3600 * 1000;

let lastSweep = 0;

function client() {
  const c = RedisStore.getClient();
  if (!c) throw new Error("REDIS_UNAVAILABLE");
  return c;
}

function sessionDir() {
  const dir = join(tmp_dir, DIRNAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function normalize(s) {
  return {
    ...s,
    filesize: Number(s.filesize),
    chunk_size: Number(s.chunk_size),
    total: Number(s.total),
    replace: Number(s.replace || 0),
  };
}

/**
 * Open a session and preallocate the target as a sparse file (no disk used
 * until chunks are written).
 */
async function createSession({ upload_id, uid, hub_id, nid, filename, filesize, replace, ownpath }) {
  const total = Math.max(1, Math.ceil(filesize / CHUNK_SIZE));
  const path = join(sessionDir(), `${upload_id}${extname(filename || "")}`);
  const fh = await open(path, "w");
  try {
    await fh.truncate(filesize);
  } finally {
    await fh.close();
  }
  const sess = {
    upload_id,
    uid: String(uid),
    hub_id: String(hub_id || ""),
    nid: String(nid || ""),
    filename: String(filename),
    filesize: String(filesize),
    chunk_size: String(CHUNK_SIZE),
    total: String(total),
    path,
    replace: String(replace ? 1 : 0),
    ownpath: String(ownpath || ""),
    ctime: String(Date.now()),
  };
  const c = client();
  await c.hSet(SESSION_KEY + upload_id, sess);
  await c.expire(SESSION_KEY + upload_id, SESSION_TTL);
  sweep().catch(() => { });
  return normalize(sess);
}

async function getSession(upload_id) {
  if (!upload_id) return null;
  const s = await client().hGetAll(SESSION_KEY + upload_id);
  if (!s?.upload_id) return null;
  return normalize(s);
}

async function received(upload_id) {
  const m = await client().sMembers(CHUNKS_KEY + upload_id);
  return (m || []).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
}

async function missing(sess) {
  const got = new Set(await received(sess.upload_id));
  const out = [];
  for (let i = 0; i < sess.total; i++) if (!got.has(i)) out.push(i);
  return out;
}

function expectedLength(sess, index) {
  return Math.min(sess.chunk_size, sess.filesize - index * sess.chunk_size);
}

/**
 * Copy an incoming chunk file into the session file at its offset. Parallel
 * chunks write disjoint ranges through separate descriptors, so no lock.
 */
function writeChunk(sess, index, src) {
  const start = index * sess.chunk_size;
  return new Promise((resolve, reject) => {
    const r = createReadStream(src);
    const w = createWriteStream(sess.path, { flags: "r+", start });
    r.on("error", reject);
    w.on("error", reject);
    w.on("finish", resolve);
    r.pipe(w);
  });
}

async function markReceived(upload_id, index) {
  const c = client();
  await c.sAdd(CHUNKS_KEY + upload_id, String(index));
  await c.expire(CHUNKS_KEY + upload_id, SESSION_TTL);
  await c.expire(SESSION_KEY + upload_id, SESSION_TTL);
}

/**
 * Drop the Redis keys; remove the session file unless store() already moved it.
 */
async function destroySession(sess, keepFile = false) {
  if (!sess?.upload_id) return;
  try {
    await client().del([SESSION_KEY + sess.upload_id, CHUNKS_KEY + sess.upload_id]);
  } catch (e) { /* redis gone: the TTL cleans up */ }
  if (!keepFile) await removeQuietly(sess.path);
}

async function removeQuietly(path) {
  if (!path) return;
  try {
    await unlink(path);
  } catch (e) { /* already gone */ }
}

/**
 * Session files whose Redis keys expired (abandoned uploads) would otherwise
 * stay on disk forever: once an hour, drop those older than SESSION_TTL.
 */
async function sweep() {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  const dir = sessionDir();
  let names = [];
  try {
    names = await readdir(dir);
  } catch (e) {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (now - st.mtimeMs > SESSION_TTL * 1000) await unlink(p);
    } catch (e) { /* raced with a live upload */ }
  }
}

module.exports = {
  CHUNK_SIZE,
  SESSION_TTL,
  createSession,
  getSession,
  received,
  missing,
  expectedLength,
  writeChunk,
  markReceived,
  destroySession,
  removeQuietly,
};
