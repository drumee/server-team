#!/usr/bin/env node
/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 * =============================================================================
 */

/**
 * One-shot backfill of document content posters (first-page thumbnails).
 *
 * For every existing document/pdf node that has no poster yet
 * (metadata.poster unset), this re-enqueues the node through the NORMAL
 * indexing pipeline: indexQueue.addFile() -> (running) indexWorker ->
 * seo_lib.index() -> generatePoster() -> writes {mfs}/thumb.png and flags
 * the node via mfs_set_poster. It only ENQUEUES; the indexWorker process
 * must be running to actually generate the posters.
 *
 * Usage:
 *   node offline/media/backfill-posters.js                 # every hub
 *   node offline/media/backfill-posters.js --dry-run       # count only, enqueue nothing
 *   node offline/media/backfill-posters.js --hub=<hubHex>  # a single hub
 *   node offline/media/backfill-posters.js --limit=500     # cap nodes per hub
 *   node offline/media/backfill-posters.js --delay=50      # ms between enqueues (throttle)
 *
 * VALIDATE FIRST: run with --dry-run (optionally --hub on a test hub) before a
 * full pass. If addFile rejects nodes, inspect the fields returned by
 * mfs_node_attr and adjust (it must supply id, hub_id, mfs_root, extension).
 */

const Minimist = require('minimist');
const { Mariadb } = require('@drumee/server-essentials');
const indexQueue = require('../queues/indexQueue');

// Extensions seo_lib.index() can turn into a poster (PDF + office it converts).
const POSTER_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'odp'];
const EXT_LIST = POSTER_EXTS.map((e) => `'${e}'`).join(',');

const argv = Minimist(process.argv.slice(2));
const DRY = !!argv['dry-run'];
const ONE_HUB = argv.hub
  ? String(argv.hub).replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  : null;
const LIMIT = parseInt(argv.limit || '0', 10);      // 0 = no cap
const DELAY_MS = parseInt(argv.delay || '50', 10);  // throttle between enqueues

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstRow = (r) => (Array.isArray(r) ? r[0] : r);

async function listHubs(yp) {
  // NOTE: entity.id is an ASCII string stored in VARBINARY — use CAST(.. AS CHAR),
  // NOT HEX() (which double-encodes). User spaces are type='drumate' area='personal'
  // and DO hold media, so include them alongside type='hub' (area='hub' alone misses them).
  let sql =
    `SELECT CAST(id AS CHAR) AS id, db_name FROM entity ` +
    `WHERE type IN ('hub','drumate') AND status='active' ` +
    `AND db_name IS NOT NULL AND db_name <> ''`;
  if (ONE_HUB) sql += ` AND CAST(id AS CHAR)='${ONE_HUB}'`;
  const rows = await yp.await_query(sql);
  return Array.isArray(rows) ? rows : [];
}

async function processHub(hub, totals) {
  const db = new Mariadb({ name: hub.db_name });
  try {
    let sql =
      `SELECT CAST(id AS CHAR) AS id FROM media ` +
      `WHERE category='document' AND LOWER(extension) IN (${EXT_LIST}) ` +
      `AND (metadata IS NULL OR JSON_EXTRACT(metadata, '$.poster') IS NULL)`;
    if (LIMIT > 0) sql += ` LIMIT ${LIMIT}`;
    const rows = await db.await_query(sql);
    const list = Array.isArray(rows) ? rows : [];
    totals.found += list.length;
    console.log(`[backfill] hub ${hub.id} (${hub.db_name}): ${list.length} node(s) missing poster`);
    if (DRY || !list.length) return;

    for (const row of list) {
      try {
        let node = firstRow(await db.await_proc('mfs_node_attr', row.id));
        if (!node || !node.id || !node.hub_id) {
          console.warn(`[backfill]   skip ${row.id}: missing node attrs`);
          totals.errors += 1;
          continue;
        }
        node.xdb = hub.db_name;
        node.actual_db = hub.db_name;
        node.hub_db = hub.db_name;
        await indexQueue.addFile(node, { uid: node.owner_id, hub_id: node.hub_id });
        totals.queued += 1;
        if (DELAY_MS) await sleep(DELAY_MS);
      } catch (e) {
        totals.errors += 1;
        console.warn(`[backfill]   enqueue ${row.id} failed: ${e.message}`);
      }
    }
  } finally {
    try { await db.end(); } catch (_) { /* ignore */ }
  }
}

async function main() {
  console.log(`[backfill] start dry-run=${DRY} hub=${ONE_HUB || 'ALL'} limit=${LIMIT || '∞'} delay=${DELAY_MS}ms`);
  const yp = new Mariadb({ name: 'yp' });
  const totals = { found: 0, queued: 0, errors: 0 };
  try {
    const hubs = await listHubs(yp);
    console.log(`[backfill] ${hubs.length} hub(s) to scan`);
    for (const hub of hubs) {
      await processHub(hub, totals);
    }
  } finally {
    try { await yp.end(); } catch (_) { /* ignore */ }
  }
  console.log(`[backfill] done: found=${totals.found} queued=${totals.queued} errors=${totals.errors}`);
  // Let Bull flush queued jobs to Redis, then exit.
  setTimeout(() => process.exit(0), 1500);
}

main().catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); });
