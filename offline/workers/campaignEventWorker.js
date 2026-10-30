/**
 * Campaign Event Worker
 *
 * Turns time and state into funnel events, then ships the yp.campaign_event
 * outbox to GA4 over the Measurement Protocol:
 *
 *   checkout_abandoned  checkout_started over an hour old with no card_added_1usd
 *   team_activated      space_created plus invitations to 2 distinct addresses
 *
 * Both derive here rather than at their call sites: invitations have several
 * writers (invite_track.source), and an abandoned checkout has no event at all.
 *
 * Credentials come from <credential_dir>/campaign-ga.json:
 *   { "measurement_id": "G-...", "api_secret": "..." }
 * Without that file rows simply wait in the outbox. Events can be backdated 72 h.
 *
 * Env:
 *   CAMPAIGN_EVENT_INTERVAL_SEC  poll cadence (default 60)
 *   CAMPAIGN_ABANDON_SEC         abandon threshold (default 3600)
 *   CAMPAIGN_GA_DEBUG            1 = GA's validation endpoint, nothing is recorded
 */

const { readFileSync } = require('fs');
const { join } = require('path');
const { Mariadb } = require('@drumee/server-essentials');
const { gaPayload } = require('../../service/lib/campaign');

const INTERVAL_MS = (parseInt(process.env.CAMPAIGN_EVENT_INTERVAL_SEC, 10) || 60) * 1000;
const ABANDON_SEC = parseInt(process.env.CAMPAIGN_ABANDON_SEC, 10) || 3600;
const DEBUG = process.env.CAMPAIGN_GA_DEBUG === '1';
const MAX_ATTEMPTS = 20;
const BATCH = 100;

let yp;

function credentials() {
  try {
    const dir = process.env.credential_dir || '/etc/drumee/credential';
    const c = JSON.parse(readFileSync(join(dir, 'campaign-ga.json'), 'utf8'));
    return c.measurement_id && c.api_secret ? c : null;
  } catch (e) {
    return null;
  }
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  return x == null ? [] : [x];
}

async function deriveEvents() {
  await yp.await_query(
    "INSERT IGNORE INTO campaign_event (uid, event, slot, plan, ctime)"
    + " SELECT s.uid, 'checkout_abandoned', '', s.plan, UNIX_TIMESTAMP() FROM campaign_event s"
    + " WHERE s.event = 'checkout_started' AND s.ctime < UNIX_TIMESTAMP() - ?"
    + " AND NOT EXISTS (SELECT 1 FROM campaign_event p WHERE p.uid = s.uid AND p.event = 'card_added_1usd')",
    ABANDON_SEC,
  );
  await yp.await_query(
    "INSERT IGNORE INTO campaign_event (uid, event, slot, plan, ctime)"
    + " SELECT s.uid, 'team_activated', '', s.plan, UNIX_TIMESTAMP() FROM campaign_event s"
    + " JOIN invite_track i ON i.inviter_id = s.uid AND i.source IN ('hub_invite', 'invite_with_roles')"
    + " WHERE s.event = 'space_created'"
    + " GROUP BY s.uid HAVING COUNT(DISTINCT i.invitee_email) >= 2",
  );
}

async function send(creds, row) {
  const host = 'https://www.google-analytics.com';
  const path = DEBUG ? '/debug/mp/collect' : '/mp/collect';
  const url = `${host}${path}?measurement_id=${creds.measurement_id}&api_secret=${creds.api_secret}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gaPayload(row)),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (DEBUG) {
    const { validationMessages = [] } = await res.json();
    if (validationMessages.length) throw new Error(JSON.stringify(validationMessages).slice(0, 240));
  }
}

async function flush() {
  const creds = credentials();
  if (!creds) return;
  const rows = asArray(await yp.await_query(
    'SELECT e.id, e.uid, e.event, e.plan, e.ctime, a.org_id, a.offer, a.utm_source, a.utm_medium,'
    + ' a.utm_campaign, a.utm_content, a.utm_term, a.gclid, a.li_fat_id, a.fbclid, a.country, a.ga_client_id'
    + ' FROM campaign_event e JOIN campaign_attribution a ON a.uid = e.uid'
    + ' WHERE e.sent_time IS NULL AND e.attempts < ? ORDER BY e.id LIMIT ?',
    MAX_ATTEMPTS, BATCH,
  ));
  for (const row of rows) {
    try {
      await send(creds, row);
      await yp.await_query('UPDATE campaign_event SET sent_time = UNIX_TIMESTAMP(), last_error = NULL WHERE id = ?', row.id);
    } catch (e) {
      await yp.await_query(
        'UPDATE campaign_event SET attempts = attempts + 1, last_error = ? WHERE id = ?',
        String((e && e.message) || e).slice(0, 255), row.id,
      );
      console.warn(`[CampaignEventWorker] ${row.event} #${row.id} failed:`, e && e.message);
    }
  }
}

async function tick() {
  try {
    await deriveEvents();
    await flush();
  } catch (e) {
    console.error('[CampaignEventWorker] tick failed:', e && e.message);
  }
  setTimeout(tick, INTERVAL_MS);
}

yp = new Mariadb({ name: 'yp' });
console.log(`[CampaignEventWorker] Poll interval: ${INTERVAL_MS / 1000}s, debug: ${DEBUG}`);
tick();
