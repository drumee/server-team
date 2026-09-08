/**
 * Meeting Reminder Worker
 *
 * Polls the global `yp.meeting_schedule` index (maintained write-through by
 * service/private/room.js book/update/remove) for scheduled meetings whose
 * start time has arrived and pushes a "your meeting is starting" reminder to
 * every attendee + the organizer via the same RedisStore fan-out the in-app
 * invite push uses (room.js _notify_invitees / expiryWorker.sendNotification).
 *
 * Model: mirrors versionRetentionWorker.js — plain setTimeout self-rescheduler
 * (the runtime ships Bull, not `cron`). Runs on a short interval rather than
 * daily because reminders are time-sensitive.
 *
 * Each meeting produces two pushes: a heads-up REMINDER_LEAD_SEC before the
 * start (notify only — the client shows no Join button that early) and the
 * "starting now" announcement. They are guarded by separate flags
 * (`early_fired` / `fired`) so one can't suppress the other.
 *
 * Env:
 *   REMINDER_INTERVAL_SEC  poll cadence (default 60)
 *   REMINDER_GRACE_SEC     don't announce meetings that started more than this
 *                          long ago, e.g. after worker downtime (default 3600;
 *                          0 = no floor)
 *   REMINDER_LEAD_SEC      how far ahead the heads-up fires (default 900 = 15
 *                          min; 0 disables the heads-up entirely)
 */

const { Mariadb, RedisStore } = require('@drumee/server-essentials');
const {admit: admitMobilePush} = require('../../service/lib/mobile-push');

const WORKER_NAME = process.env.WORKER_NAME || 'reminder-worker-1';
const INTERVAL_MS = (parseInt(process.env.REMINDER_INTERVAL_SEC, 10) || 60) * 1000;
const GRACE_SEC = Number.isInteger(parseInt(process.env.REMINDER_GRACE_SEC, 10))
  ? parseInt(process.env.REMINDER_GRACE_SEC, 10)
  : 3600;
const LEAD_SEC = Number.isInteger(parseInt(process.env.REMINDER_LEAD_SEC, 10))
  ? parseInt(process.env.REMINDER_LEAD_SEC, 10)
  : 900;

console.log(`[ReminderWorker] Starting worker: ${WORKER_NAME}`);
console.log(
  `[ReminderWorker] Poll interval: ${INTERVAL_MS / 1000}s, grace: ${GRACE_SEC}s, lead: ${LEAD_SEC}s`,
);

let yp;
let redisInitialized = false;

function asArray(x) {
  if (Array.isArray(x)) return x;
  return x == null ? [] : [x];
}

function parseJSON(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

async function initialize() {
  yp = new Mariadb({ name: 'yp' });
  console.log('[ReminderWorker] Database connected');
  await RedisStore.prototype.init.call(new RedisStore());
  redisInitialized = true;
  console.log('[ReminderWorker] RedisStore initialized');
}

/**
 * Does the meeting this index row points at still exist?
 *
 * `meeting_schedule` is a global mirror kept write-through by room.book /
 * update / remove. Anything that drops a schedule node by another route — the
 * workspace being deleted, the node removed through MFS, an _unindex_meeting
 * that failed — leaves the row behind, and the worker then announces a meeting
 * that is on nobody's calendar: exactly the "I deleted it but the popup still
 * came" report.
 *
 * The predicate is the one room_list_scheduled lists on, so the reminder and
 * the calendar can never disagree about what exists. Answers false ONLY when
 * the answer is definitive — anything unexpected (a query that throws, a
 * connection blip) answers true, because dropping a live meeting's reminders
 * is far worse than sending one extra.
 */
async function meetingStillExists(m) {
  try {
    const entity = asArray(
      await yp.await_query('SELECT db_name FROM entity WHERE id=?', m.hub_id),
    );
    const db = entity[0] && entity[0].db_name;
    // No entity row: the workspace itself is gone, so the meeting is too.
    if (!db) return false;
    const rows = asArray(
      await yp.await_query(
        `SELECT id FROM \`${db}\`.media
          WHERE id=? AND category='schedule' AND status='active'`,
        m.nid,
      ),
    );
    return rows.length > 0;
  } catch (e) {
    console.error(
      `[ReminderWorker] existence check failed for meeting ${m && m.nid}:`,
      e.message,
    );
    return true;
  }
}

/**
 * Forget an index row whose meeting is gone, so it stops being rescanned (and
 * announced) on every poll.
 */
async function dropStaleIndex(m) {
  try {
    await yp.await_proc('meeting_schedule_remove', m.hub_id, m.nid);
    console.log(
      `[ReminderWorker] dropped stale index row for meeting ${m.nid} (hub ${m.hub_id}) — node no longer exists`,
    );
  } catch (e) {
    console.error(`[ReminderWorker] could not drop stale row ${m && m.nid}:`, e.message);
  }
}

/**
 * First occurrence strictly after `now` for a recurring meeting, or null for a
 * one-off / an ended series. Advances past any occurrences missed while the
 * worker was down so we don't fire a burst of back-dated reminders.
 */
function nextOccurrence(stime, etime, recur, now) {
  if (!recur || !recur.freq || recur.freq === 'none') return null;
  const dur = etime > stime ? etime - stime : 0;
  const until = recur.until ? Number(recur.until) : null;
  let next = stime;
  let guard = 0;
  do {
    if (recur.freq === 'daily') next += 86400;
    else if (recur.freq === 'weekly') next += 604800;
    else if (recur.freq === 'monthly') {
      const d = new Date(next * 1000);
      d.setMonth(d.getMonth() + 1);
      next = Math.floor(d.getTime() / 1000);
    } else return null;
    if (until && next > until) return null;
  } while (next <= now && guard++ < 1000);
  return { stime: next, etime: next + dur };
}

/**
 * Roll a row past its due occurrence WITHOUT notifying: a recurring series
 * moves to its next future occurrence (fired back to 0), a one-off is flagged
 * fired so it stops being rescanned every minute forever.
 */
async function sweepOverdue(m, now) {
  const recur = parseJSON(m.recur, null);
  const next = nextOccurrence(Number(m.stime) || 0, Number(m.etime) || 0, recur, now);
  await yp.await_proc('meeting_schedule_mark_fired', m.id, next ? next.stime : 0, next ? next.etime : 0);
  return next;
}

/**
 * Push one meeting notification to every attendee + the organizer.
 * `lead` is 0 for the "starting now" announcement, or the number of seconds
 * ahead for the heads-up — the client keys its wording and whether it offers a
 * Join button off that.
 */
async function notify(m, lead) {
  const attendees = asArray(parseJSON(m.attendees, []))
    .map((a) => (a && (a.uid || a)))
    .filter(Boolean);
  // The organizer wants a reminder too, not just the invitees.
  const uids = [...new Set([...attendees, m.created_by].filter(Boolean))];
  if (!uids.length) return 0;

  await admitMobilePush({
    type: 'room.reminder',
    actor_id: m.created_by || '',
    hub_id: m.hub_id,
    key_id: m.nid,
    occurred_at: Number(m.stime) || Math.floor(Date.now() / 1000),
    event_phase: lead ? 'upcoming' : 'start',
    recipient_uids: uids,
  });

  const recipients = asArray(await yp.await_proc('user_sockets', uids));
  if (!recipients.length || !redisInitialized) return 0;

  // The envelope Logger.payload() builds for in-request pushes: the client
  // reads `payload.model` as the handler's data argument and
  // `payload.options.service` as the routing key. A worker has no session and
  // so no this.payload(), so it is written out by hand — sending the fields
  // flat leaves the handler with data=undefined and no matching case.
  await RedisStore.sendData(
    {
      model: {
        type: lead ? 'meeting_upcoming' : 'meeting_reminder',
        // Minutes until the start, 0 for "now" — the client renders the
        // wording from this and hides Join while it is non-zero.
        lead_min: lead ? Math.round(lead / 60) : 0,
        hub_id: m.hub_id,
        nid: m.nid,
        room_id: m.nid,
        title: m.title,
        // Agenda + invitee list drive the reminder card's description line and
        // its avatar row.
        message: m.message || '',
        attendees: asArray(parseJSON(m.attendees, [])),
        stime: Number(m.stime) || 0,
        timestamp: Date.now(),
      },
      options: {
        service: 'room.reminder',
        keys: '*',
      },
    },
    recipients,
  );
  console.log(
    `[ReminderWorker] ${lead ? `heads-up (${Math.round(lead / 60)}min)` : 'reminded'}` +
    ` ${recipients.length} socket(s) for meeting ${m.nid} (hub ${m.hub_id})`,
  );
  return recipients.length;
}

async function fireReminder(m, now) {
  await notify(m, 0);
  // Advance recurring meetings to their next occurrence; flag one-offs fired.
  await sweepOverdue(m, now);
}

/**
 * Heads-up for a meeting starting shortly. Flagged even when nobody was
 * reachable, so a user who happens to be offline at T-15 doesn't get the
 * heads-up replayed every minute until the meeting starts.
 */
async function fireEarlyReminder(m, now) {
  await notify(m, Math.max(0, (Number(m.stime) || 0) - now));
  await yp.await_proc('meeting_schedule_mark_early', m.id);
}

/**
 * Heads-up pass: meetings starting within the lead window that haven't had
 * theirs yet. Runs on every poll alongside the start-time pass.
 */
async function runEarlyPass(now) {
  if (LEAD_SEC <= 0) return;
  const upcoming = asArray(await yp.await_proc('meeting_schedule_upcoming', now, LEAD_SEC));
  if (!upcoming.length) return;
  for (const m of upcoming) {
    try {
      if (!(await meetingStillExists(m))) {
        await dropStaleIndex(m);
        continue;
      }
      await fireEarlyReminder(m, now);
    } catch (e) {
      console.error(`[ReminderWorker] heads-up failed on meeting ${m && m.nid}:`, e.message);
    }
  }
}

async function runReminderJob() {
  const now = Math.floor(Date.now() / 1000);
  try {
    await runEarlyPass(now);
  } catch (error) {
    console.error('[ReminderWorker] Early pass failed:', error.message);
  }
  try {
    // Every unfired past-due row (grace 0 = no floor); the grace rule is
    // applied below instead of in SQL. Filtering in the proc left an
    // occurrence that slipped past the window invisible forever — only
    // fireReminder() advanced a row, so a recurring series whose first
    // occurrence was missed never fired and never rolled forward again.
    const due = asArray(await yp.await_proc('meeting_schedule_due', now, 0));
    if (!due.length) return;
    let fired = 0;
    let swept = 0;
    let stale = 0;
    for (const m of due) {
      try {
        // Deleted meetings must not announce themselves. Checked before the
        // grace rule so a stale row is retired outright rather than swept
        // forward to an occurrence that will never happen either.
        if (!(await meetingStillExists(m))) {
          await dropStaleIndex(m);
          stale++;
          continue;
        }
        const stime = Number(m.stime) || 0;
        if (GRACE_SEC === 0 || stime >= now - GRACE_SEC) {
          await fireReminder(m, now);
          fired++;
        } else {
          // Too late to announce, but still roll it forward so a recurring
          // series comes back to life on its next future occurrence.
          const next = await sweepOverdue(m, now);
          swept++;
          console.log(
            `[ReminderWorker] swept overdue meeting ${m.nid} (hub ${m.hub_id}, ${now - stime}s late)` +
            (next ? ` → next occurrence ${new Date(next.stime * 1000).toISOString()}` : ' → closed'),
          );
        }
      } catch (e) {
        console.error(`[ReminderWorker] failed on meeting ${m && m.nid}:`, e.message);
      }
    }
    console.log(
      `[ReminderWorker] ${due.length} due at ${new Date().toISOString()} — ${fired} reminded, ${swept} swept, ${stale} stale`,
    );
  } catch (error) {
    console.error('[ReminderWorker] Job failed:', error.message);
  }
}

/**
 * Poll ON the wall-clock boundary, not `INTERVAL_MS` after the previous run.
 *
 * Meetings are scheduled to the minute and announced only once `stime <= now`,
 * so where the tick falls inside the minute IS the delay the user sees. A
 * chained `setTimeout(INTERVAL_MS)` puts it at whatever second the process
 * happened to start on — measured at :30 past every minute on stage, i.e. a
 * meeting set for 19:54 popped up at 19:54:30 — and it creeps further out over
 * time, because the next timer is only armed once the current run has
 * finished. Aligning removes both: the announcement now lands within a
 * fraction of a second of the scheduled minute, at the same one-query-per-poll
 * cost, and the accumulated drift is re-zeroed on every tick.
 *
 * TICK_SKEW_MS keeps `now` on the far side of the boundary if the timer fires
 * a hair early; landing at 19:53:59.999 would read as "not due yet" and cost a
 * whole extra period.
 */
const TICK_SKEW_MS = 250;

function scheduleNext() {
  const delay = INTERVAL_MS - (Date.now() % INTERVAL_MS) + TICK_SKEW_MS;
  setTimeout(async () => {
    try {
      await runReminderJob();
    } finally {
      scheduleNext();
    }
  }, delay);
}

async function startWorker() {
  console.log('[ReminderWorker] Initializing...');
  await initialize();
  scheduleNext();
  process.on('SIGUSR2', async () => {
    console.log('[ReminderWorker] SIGUSR2 — manual run');
    await runReminderJob();
  });
  console.log('[ReminderWorker] Worker started. Manual run: kill -USR2', process.pid);
}

async function shutdown() {
  console.log('[ReminderWorker] Shutting down...');
  try {
    if (yp && yp.connection) await yp.end();
  } catch (error) {
    console.error('[ReminderWorker] Shutdown error:', error.message);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (error) => {
  console.error('[ReminderWorker] Uncaught exception:', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ReminderWorker] Unhandled rejection:', reason);
  process.exit(1);
});

startWorker().catch((error) => {
  console.error('[ReminderWorker] Failed to start worker:', error);
  process.exit(1);
});

console.log('[ReminderWorker] Worker process started (PID:', process.pid, ')');

module.exports = { runReminderJob };
