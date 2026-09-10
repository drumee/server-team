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
 * Archive inspection and extraction, shared by the `media.unzip` service — which
 * inspects so it can refuse fast, with a reason the user can act on — and
 * offline/media/unzip.js, which extracts.
 *
 * Everything shells out to 7z, the tool the platform already ships and already
 * uses to BUILD archives (Script.archive -> make-zip.sh runs `7z a`), so a zip
 * Drumee produced is always one it can read back.
 *
 * TWO VERSIONS ARE IN PLAY AND BOTH MUST WORK: p7zip 16.02 inside the
 * production `drumee` container, 7-Zip 25.01 on stage. Their human-readable
 * `7z l` tables differ in column layout; `-slt` ("show technical") is the one
 * format whose field NAMES match across both, which is why listing parses that
 * and nothing else. Verified on both hosts before this was written.
 */

const { spawn } = require("child_process");
const { isAbsolute } = require("path");

/**
 * Extensions we accept. Every one is handled by the codecs compiled into
 * p7zip 16.02 on production (`7z i` lists zip/7z/Rar/Rar5/tar/gzip/bzip2/xz),
 * so none of these can arrive as a "format not supported" failure inside the
 * offline worker where the user would never see the reason.
 *
 * This list is the ALLOW-list, and it is deliberately narrower than "whatever
 * 7z will open": the zip codec also claims docx/xlsx/odt/ods/epub/jar, which
 * are zip containers but are `document` category to us. The service gates on
 * media.category = 'zip' as well, so an Office file can never reach here — the
 * two checks agree, and neither alone is load-bearing.
 */
const ARCHIVE_EXTENSIONS = [
  "zip", "7z", "rar", "tar", "gz", "gzip", "tgz", "bz2", "tbz2", "xz", "txz",
];

/** A single archive may not import more nodes than this. */
const MAX_ENTRIES = 20000;

/**
 * Absolute ceiling on uncompressed bytes, independent of the account's quota.
 * The quota check is the real gate; this stops a decompression bomb from
 * filling the disk in the window BEFORE the quota check can measure it, and
 * bounds how long an extraction can occupy the box.
 */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

/**
 * The small/big line for what a CLICK on an archive does (Natrix, 2026-09-10):
 * a SMALL one is extracted straight away, a BIG one asks first and then shows
 * progress. "Small" therefore means "finishes fast enough that asking would be
 * more interruption than the wait", which is a question of both how much data
 * has to be written and how many rows have to be created — so it is two
 * limits, and an archive must be under both.
 *
 * Tunable on purpose: these are a product judgement, not a technical one.
 */
const SMALL_MAX_ENTRIES = 100;
const SMALL_MAX_BYTES = 25 * 1024 * 1024;

/** `media`.`user_filename` is varchar(128); `file_path` is varchar(1000). */
const MAX_FILENAME = 128;
const MAX_FILE_PATH = 1000;

/** The `-slt` fields the listing parse reads; everything else is discarded. */
const ENTRY_FIELDS = new Set([
  "Path", "Folder", "Size", "Encrypted", "Attributes", "Mode", "Type",
]);

/** Guard against a hostile or corrupt archive wedging a worker forever. */
const LIST_TIMEOUT_MS = 60 * 1000;
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Reasons `inspect` can refuse. Each maps to a message the service turns into
 * something the user reads, so they are values, not prose.
 */
const REFUSED = {
  UNREADABLE: "ARCHIVE_UNREADABLE",
  ENCRYPTED: "ARCHIVE_ENCRYPTED",
  EMPTY: "ARCHIVE_EMPTY",
  TOO_MANY_ENTRIES: "ARCHIVE_TOO_MANY_ENTRIES",
  TOO_LARGE: "ARCHIVE_TOO_LARGE",
  UNSAFE_PATH: "ARCHIVE_UNSAFE_PATH",
};

/**
 * True when an archive entry path would escape the directory we extract into.
 *
 * This is the zip-slip check, and it runs BEFORE extraction rather than after,
 * because after is too late: the damage of `../../etc/whatever` is done the
 * moment 7z writes it, and our own tree walk — which only ever reads inside the
 * staging directory — would never even see the file that escaped. p7zip 16.02
 * predates the CVE-2018-10115 era hardening, so this cannot be delegated to it.
 *
 * Backslashes are normalised first: a zip written on Windows separates with
 * them, and `..\..\x` has to be caught as traversal rather than read as one odd
 * filename.
 */
function isUnsafeEntryPath(p) {
  if (!p) return true;
  const norm = String(p).replace(/\\/g, "/");
  if (isAbsolute(norm) || norm.startsWith("/")) return true;
  if (/^[a-zA-Z]:/.test(norm)) return true; // c:\... drive-absolute
  return norm.split("/").some((seg) => seg === "..");
}

/**
 * Run a command, streaming stdout through `onLine`. Resolves with the exit
 * code; never rejects on a non-zero exit — a refusal is data here, not an
 * exception. `onLine` may return false to abort, which kills the child: that is
 * how listing stops reading a 5-million-entry archive instead of buffering it.
 */
function run(cmd, args, { timeout, onLine }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, error: e, aborted: false });
      return;
    }
    let stderr = "";
    let buf = "";
    let aborted = false;
    let settled = false;

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, error, aborted, stderr });
    };

    const timer = setTimeout(() => {
      aborted = true;
      try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
      finish(-1, new Error("TIMEOUT"));
    }, timeout);

    child.stdout.on("data", (d) => {
      if (aborted) return;
      buf += d.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (onLine && onLine(line) === false) {
          aborted = true;
          try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
          finish(0);
          return;
        }
      }
    });
    // Bounded: a 7z failure prints a few lines, but a corrupt archive can
    // print one per entry, and this string is only ever used for the log.
    child.stderr.on("data", (d) => {
      if (stderr.length < 8192) stderr += d.toString("utf8");
    });
    child.on("error", (e) => finish(-1, e));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Read an archive's table of contents without extracting it.
 *
 * @param {string} archivePath absolute path to the archive
 * @returns {Promise<object>} `{ok:true, files, folders, totalBytes}` or
 *   `{ok:false, reason}` where reason is one of REFUSED.
 *
 * `-p` (empty password) is not optional. Without it 7z PROMPTS on an encrypted
 * archive; with no tty attached that prompt is a process that never exits and
 * never prints, i.e. exactly the hang this whole feature exists to remove.
 * With `-p` a header-encrypted archive exits 2 immediately (verified on both
 * 7z versions), and a body-encrypted zip lists fine and is caught below by its
 * `Encrypted = +` flag.
 */
async function inspect(archivePath) {
  if (!isAbsolute(archivePath)) {
    // Also why no `--` end-of-flags marker is needed anywhere in this file:
    // every path we hand 7z starts with a slash, so none can be read as an
    // option however the file was named.
    return { ok: false, reason: REFUSED.UNREADABLE };
  }

  let files = 0;
  let folders = 0;
  let totalBytes = 0;
  let encrypted = false;
  let unsafe = false;
  let overflow = false;

  // -slt blocks are separated by blank lines, and WHICH FIELDS A BLOCK HAS
  // depends on the container format, not just the 7z version:
  //
  //   zip   Folder = +/-   Attributes = D drwx… (25.01) / D_ drwx… (16.02)
  //   tar   Folder = +/-   Mode       = drwx…      (no Attributes at all)
  //   7z    (no Folder)    Attributes = D drwx…
  //   gzip  (no Folder)    (no Attributes)         single file, Size only
  //
  // So neither `Folder` nor `Attributes` alone identifies an entry or a
  // directory. A bare `Size` is the one field every entry has in every format
  // — and no header block has one: headers carry Type, Physical Size and
  // Headers Size, all of which are DIFFERENT keys under exact match. `Type` is
  // required to be absent as a second, independent guard, so a future format
  // that adds `Size` to its header still cannot be counted as a file.
  let cur = null;
  const flush = () => {
    if (!cur || cur.Size === undefined || cur.Type !== undefined) { cur = null; return true; }
    if (isUnsafeEntryPath(cur.Path)) { unsafe = true; return false; }
    if (cur.Encrypted === "+") { encrypted = true; return false; }
    const isDir =
      cur.Folder === "+" ||
      /^D/.test(cur.Attributes || "") ||
      /^d/.test(cur.Mode || "");
    if (isDir) {
      folders++;
    } else {
      files++;
      const n = parseInt(cur.Size, 10);
      if (!isNaN(n) && n > 0) totalBytes += n;
    }
    if (files + folders > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
      overflow = true;
      return false;
    }
    cur = null;
    return true;
  };

  const r = await run("7z", ["l", "-slt", "-p", archivePath], {
    timeout: LIST_TIMEOUT_MS,
    onLine: (line) => {
      if (line === "") return flush();
      const eq = line.indexOf(" = ");
      if (eq < 0) return true;
      const key = line.slice(0, eq);
      // Only the handful of fields this cares about; -slt prints ~18 per entry
      // and building objects out of all of them is pure garbage for 20k rows.
      // Exact match matters: `Physical Size` / `Headers Size` / `Packed Size`
      // all contain the word and none of them is the `Size` we mean.
      if (!ENTRY_FIELDS.has(key)) return true;
      if (!cur) cur = {};
      cur[key] = line.slice(eq + 3);
      return true;
    },
  });
  flush();

  if (unsafe) return { ok: false, reason: REFUSED.UNSAFE_PATH };
  if (encrypted) return { ok: false, reason: REFUSED.ENCRYPTED };
  if (files + folders > MAX_ENTRIES) return { ok: false, reason: REFUSED.TOO_MANY_ENTRIES };
  if (totalBytes > MAX_TOTAL_BYTES) return { ok: false, reason: REFUSED.TOO_LARGE };
  if (overflow) return { ok: false, reason: REFUSED.TOO_LARGE };
  // A non-zero exit that we did NOT abort ourselves means 7z could not read it
  // — wrong magic, truncated upload, a rar5 body in a .zip name, or the
  // header-encrypted case that exits 2 under `-p`.
  if (r.code !== 0) return { ok: false, reason: REFUSED.UNREADABLE, detail: r.stderr };
  if (files === 0) return { ok: false, reason: REFUSED.EMPTY };

  return { ok: true, files, folders, totalBytes };
}

/**
 * Extract into `destDir`, which must already exist and must be a directory
 * nothing else is using — the caller owns it and is expected to delete it.
 *
 * `-y` answers the overwrite prompt, `-bd` drops the progress redraw (which on
 * a pipe is megabytes of carriage returns), `-p` is the anti-prompt guard
 * described on `inspect`. `-o` takes no space before its value.
 *
 * @returns {Promise<{ok:boolean, code:number, stderr:string}>}
 */
async function extract(archivePath, destDir) {
  const r = await run(
    "7z",
    ["x", "-y", "-bd", "-p", `-o${destDir}`, archivePath],
    { timeout: EXTRACT_TIMEOUT_MS, onLine: () => true },
  );
  return { ok: r.code === 0, code: r.code, stderr: r.stderr || "" };
}

module.exports = {
  ARCHIVE_EXTENSIONS,
  EXTRACT_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  MAX_ENTRIES,
  MAX_FILENAME,
  MAX_FILE_PATH,
  MAX_TOTAL_BYTES,
  REFUSED,
  SMALL_MAX_BYTES,
  SMALL_MAX_ENTRIES,
  extract,
  inspect,
  isUnsafeEntryPath,
};
