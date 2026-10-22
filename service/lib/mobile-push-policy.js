const {GENERIC_NOTIFICATION} = require('./mobile-push-content');
const FCM_REQUEST_TIMEOUT_MS = 25000;

function transientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function permanentFcmError(status, body) {
  const details = body && body.error && body.error.details;
  const codes = Array.isArray(details)
    ? details
      .filter(detail => detail && /firebase\.fcm\.v1\.FcmError$/.test(String(detail['@type'] || '')))
      .map(detail => detail.errorCode)
      .filter(Boolean)
    : [];
  return codes.some(code => [
    'INVALID_ARGUMENT',
    'UNREGISTERED',
    'SENDER_ID_MISMATCH',
  ].includes(code));
}

// What the app needs to ring a call from its push (drumee-mobile
// `pushedCallFrom`): the room, the caller, and when the ring goes stale, in
// epoch seconds. A callee with no socket gets no room yet — the caller's
// 3-second re-invite rings them once the tap has opened the app.
function callData(delivery) {
  return {
    ...(delivery.room_id ? {room_id: String(delivery.room_id)} : {}),
    ...(delivery.room_type ? {room_type: String(delivery.room_type)} : {}),
    actor_id: String(delivery.actor_id || ''),
    expires_at: String(delivery.expires_at),
  };
}

// Repeated rings of one call replace each other's banner instead of stacking.
function callCollapseKey(delivery) {
  return delivery.room_id ? String(delivery.room_id) : `dial-${delivery.actor_id || ''}`;
}

function buildFcmMessage(delivery, pushToken, notification = GENERIC_NOTIFICATION, now = Date.now()) {
  const title = String(notification.title || GENERIC_NOTIFICATION.title);
  const body = String(notification.body || GENERIC_NOTIFICATION.body);
  const subtitle = String(notification.subtitle || '');
  const call = delivery.type === 'conference.invite';
  const remaining = Number(delivery.expires_at) - Math.floor(now / 1000);
  // A ring outlives its call by nothing: Android drops it when the call is over.
  const ttlSeconds = call && Number.isFinite(remaining) ? Math.max(1, remaining) : 3600;
  return {
    message: {
      token: pushToken,
      notification: {title, body},
      data: {
        event_id: String(delivery.event_id),
        event_type: String(delivery.type),
        key_id: String(delivery.key_id || ''),
        hub_id: String(delivery.hub_id || ''),
        registration_id: String(delivery.registration_id),
        binding_version: String(delivery.binding_version),
        state_version: String(delivery.state_version),
        ...(call ? callData(delivery) : {}),
      },
      android: {
        priority: 'high',
        ttl: `${ttlSeconds}s`,
        // Android has no subtitle slot, so the workspace line leads the body.
        notification: {
          channel_id: 'drumee_activity',
          ...(subtitle ? {body: `${subtitle}\n${body}`} : {}),
          ...(call ? {tag: callCollapseKey(delivery)} : {}),
        },
      },
      apns: {
        headers: {
          'apns-expiration': String(delivery.expires_at),
          'apns-priority': '10',
          'apns-push-type': 'alert',
          ...(call ? {'apns-collapse-id': callCollapseKey(delivery)} : {}),
        },
        // iOS draws the three lines natively: title / subtitle / body.
        // Other pushes stay silent by design; a call has to be heard.
        payload: {aps: {
          alert: {title, ...(subtitle ? {subtitle} : {}), body},
          ...(call ? {sound: 'default'} : {}),
          'content-available': 1,
        }},
      },
    },
  };
}

function registrationLookupArgs(delivery) {
  return [
    delivery.registration_id,
    delivery.recipient_uid,
    delivery.binding_version,
    delivery.state_version,
  ];
}

function nextRegistrationCursor(page, currentCursor) {
  if (!page.length) return null;
  const next = Number(page[page.length - 1].registration_id);
  return Number.isSafeInteger(next) && next > currentCursor ? next : null;
}

function fcmSuccessOutcome() {
  return {sent: true};
}

module.exports = {
  FCM_REQUEST_TIMEOUT_MS,
  buildFcmMessage,
  fcmSuccessOutcome,
  nextRegistrationCursor,
  permanentFcmError,
  registrationLookupArgs,
  transientStatus,
};
