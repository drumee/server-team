const {GoogleAuth} = require('google-auth-library');
const {Mariadb, sysEnv, toArray} = require('@drumee/server-essentials');
const {mobilePushQueue, addDelivery} = require('../queues/mobilePushQueue');
const {
  FCM_REQUEST_TIMEOUT_MS,
  buildFcmMessage,
  fcmSuccessOutcome,
  nextRegistrationCursor,
  permanentFcmError,
  registrationLookupArgs,
  transientStatus,
} = require('../../service/lib/mobile-push-policy');
const {
  activeHubMemberUids,
  eligibleRecipientUids,
  hubMemberPageArguments,
  pagedHubMembers,
  privilegeAllows,
} = require('../../service/lib/mobile-push-recipients');
const {
  createMobilePushAuthorization,
} = require('../../service/lib/mobile-push-authorization');
const {
  createMobilePushContent,
} = require('../../service/lib/mobile-push-content');

const runtimeEnv = sysEnv();
const PROJECT_ID = runtimeEnv.firebase_project_id || 'drumee-7ffcc';
const QUEUE_GENERATION = String(runtimeEnv.mobile_push_queue_generation || 1);
const yp = new Mariadb({name: 'yp'});
const auth = new GoogleAuth({
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/firebase.messaging',
  ],
});
const {recipientAllowed} = createMobilePushAuthorization(yp);
const {resolveNotification} = createMobilePushContent(yp);
let shuttingDown = false;

function errorCode(error) {
  return String(error && (error.code || error.name) || 'UNKNOWN')
    .replace(/[^0-9A-Za-z_.-]/g, '_')
    .slice(0, 64);
}

function log(event, fields = {}) {
  console.log(JSON.stringify({event, ...fields}));
}

function logError(event, error, fields = {}) {
  console.error(JSON.stringify({event, code: errorCode(error), ...fields}));
}

async function eligibleUids(event) {
  if (!event.hub_id) {
    const candidates = eligibleRecipientUids(event);
    const allowed = [];
    for (const uid of candidates) {
      if (await recipientAllowed(event, uid)) allowed.push(uid);
    }
    return allowed;
  }
  const currentMembers = await pagedHubMembers(async page => toArray(
    await yp.await_proc(
      'forward_proc',
      event.hub_id,
      'hub_members_for_mobile_push',
      hubMemberPageArguments(page),
    ),
  ));
  let currentHubUids = activeHubMemberUids(event, currentMembers);
  if (event.type === 'channel.post' && event.scope_nid) {
    const scoped = [];
    for (const uid of currentHubUids) {
      const rows = toArray(await yp.await_proc(
        'forward_proc',
        event.hub_id,
        'mfs_access_node',
        `'${uid}','${event.scope_nid}'`,
      ));
      const node = rows[0] || {};
      if (privilegeAllows(node.privilege ?? node.permission, 0b0000100)) {
        scoped.push(uid);
      }
    }
    currentHubUids = scoped;
  }
  const candidates = eligibleRecipientUids(event, currentHubUids);
  const allowed = [];
  for (const uid of candidates) {
    if (await recipientAllowed(event, uid)) allowed.push(uid);
  }
  return allowed;
}

async function registrationsFor(uids) {
  if (!uids.length) return [];
  const registrations = [];
  const pageSize = 500;
  let cursor = 0;
  for (;;) {
    const page = toArray(await yp.await_proc(
      'push_registration_list',
      JSON.stringify(uids),
      cursor,
      pageSize,
    ));
    registrations.push(...page);
    if (page.length < pageSize) break;
    const next = nextRegistrationCursor(page, cursor);
    if (next === null) break;
    cursor = next;
  }
  return registrations;
}

async function admitEvent(job) {
  const event = job.data;
  if (String(event.queue_generation) !== QUEUE_GENERATION) return {expired: true};
  if (Number(event.expires_at) <= Math.floor(Date.now() / 1000)) return {expired: true};
  const registrations = await registrationsFor(await eligibleUids(event));
  for (const registration of registrations) {
    await addDelivery({
      ...event,
      registration_id: registration.registration_id,
      recipient_uid: registration.uid,
      registration_kind: registration.registration_kind,
      binding_version: registration.binding_version,
      state_version: registration.state_version,
    });
  }
  return {deliveries: registrations.length};
}

async function sendFcm(delivery) {
  if (!delivery.recipient_uid || !await recipientAllowed(
    delivery,
    delivery.recipient_uid,
  )) {
    return {unauthorized: true};
  }
  const registrations = toArray(await yp.await_proc(
    'push_registration_get',
    ...registrationLookupArgs(delivery),
  ));
  const registration = registrations[0];
  if (!registration || !registration.push_token) return {expired: true};
  const notification = await resolveNotification(delivery);
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildFcmMessage(delivery, registration.push_token, notification)),
      signal: AbortSignal.timeout(FCM_REQUEST_TIMEOUT_MS),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (response.ok) return fcmSuccessOutcome();
  if (permanentFcmError(response.status, body)) {
    await yp.await_proc(
      'device_registration_v2_invalidate',
      delivery.registration_id,
      delivery.binding_version,
      delivery.state_version,
    );
    return {invalidated: true};
  }
  const error = new Error(`FCM_${response.status}`);
  if (!transientStatus(response.status)) error.retryable = false;
  throw error;
}

function registerQueueHandlers() {
  mobilePushQueue.on('error', error => logError('mobile_push_queue_error', error));
  mobilePushQueue.on('stalled', job => log('mobile_push_job_stalled', {
    job_name: String(job && job.name || 'unknown'),
    event_id: String(job && job.data && job.data.event_id || ''),
  }));
  mobilePushQueue.on('failed', (job, error) => logError('mobile_push_job_failed', error, {
    job_name: String(job && job.name || 'unknown'),
    event_id: String(job && job.data && job.data.event_id || ''),
    attempts_made: Number(job && job.attemptsMade || 0),
  }));
  mobilePushQueue.on('completed', (job, outcome) => log('mobile_push_job_completed', {
    job_name: String(job && job.name || 'unknown'),
    event_id: String(job && job.data && job.data.event_id || ''),
    outcome: String(Object.keys(outcome || {})[0] || 'completed'),
  }));
}

async function start() {
  registerQueueHandlers();
  await Promise.all([
    mobilePushQueue.isReady(),
    yp.await_query('SELECT 1 AS ready'),
    auth.getAccessToken(),
  ]);
  mobilePushQueue.process('admit-event', 4, admitEvent);
  mobilePushQueue.process('deliver', 10, async job => {
    if (String(job.data.queue_generation) !== QUEUE_GENERATION) return {expired: true};
    if (Number(job.data.expires_at) <= Math.floor(Date.now() / 1000)) return {expired: true};
    try {
      return await sendFcm(job.data);
    } catch (error) {
      if (error.retryable === false) job.discard();
      throw error;
    }
  });
  log('mobile_push_worker_ready', {
    firebase_project_id: PROJECT_ID,
    queue_generation: QUEUE_GENERATION,
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('mobile_push_worker_stopping', {signal});
  const hardStop = setTimeout(() => process.exit(1), 10000);
  hardStop.unref();
  await Promise.allSettled([mobilePushQueue.close(), yp.end()]);
  clearTimeout(hardStop);
  log('mobile_push_worker_stopped');
  process.exit(0);
}

if (require.main === module) {
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  start().catch(error => {
    logError('mobile_push_worker_start_failed', error);
    process.exit(1);
  });
}

module.exports = {
  admitEvent,
  eligibleUids,
  errorCode,
  permanentFcmError,
  sendFcm,
  start,
  transientStatus,
};
