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

function buildFcmMessage(delivery, pushToken, notification = GENERIC_NOTIFICATION) {
  return {
    message: {
      token: pushToken,
      notification: {
        title: String(notification.title || GENERIC_NOTIFICATION.title),
        body: String(notification.body || GENERIC_NOTIFICATION.body),
      },
      data: {
        event_id: String(delivery.event_id),
        event_type: String(delivery.type),
        key_id: String(delivery.key_id || ''),
        hub_id: String(delivery.hub_id || ''),
        registration_id: String(delivery.registration_id),
        binding_version: String(delivery.binding_version),
        state_version: String(delivery.state_version),
      },
      android: {
        priority: 'high',
        ttl: '3600s',
        notification: {channel_id: 'drumee_activity'},
      },
      apns: {
        headers: {
          'apns-expiration': String(delivery.expires_at),
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
        payload: {aps: {'content-available': 1}},
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
