const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FCM_REQUEST_TIMEOUT_MS,
  buildFcmMessage,
  fcmSuccessOutcome,
  nextRegistrationCursor,
  permanentFcmError,
  registrationLookupArgs,
  transientStatus,
} = require('../service/lib/mobile-push-policy');

test('builds a generic string-only payload without private content', () => {
  const payload = buildFcmMessage({
    event_id: 'event-1',
    type: 'channel.post',
    key_id: 'message-1',
    hub_id: 'hub-1',
    registration_id: 7,
    binding_version: 3,
    state_version: 4,
    expires_at: 123,
    message: 'private body',
    filename: 'secret.pdf',
  }, 'token-value');

  assert.deepEqual(payload.message.data, {
    event_id: 'event-1',
    event_type: 'channel.post',
    key_id: 'message-1',
    hub_id: 'hub-1',
    registration_id: '7',
    binding_version: '3',
    state_version: '4',
  });
  assert.equal(JSON.stringify(payload).includes('private body'), false);
  assert.equal(JSON.stringify(payload).includes('secret.pdf'), false);
  assert.equal(payload.message.android.notification.channel_id, 'drumee_activity');
  assert.deepEqual(payload.message.notification, {
    title: 'Drumee',
    body: 'You have new activity',
  });
});

test('carries the resolved notification and falls back on a blank one', () => {
  const delivery = {
    event_id: 'event-1',
    type: 'channel.post',
    registration_id: 7,
    binding_version: 3,
    state_version: 4,
    expires_at: 123,
  };

  assert.deepEqual(
    buildFcmMessage(delivery, 'token-value', {
      title: 'Temp Test',
      body: 'Posted in Marketing',
    }).message.notification,
    {title: 'Temp Test', body: 'Posted in Marketing'},
  );

  assert.deepEqual(
    buildFcmMessage(delivery, 'token-value', {title: '', body: ''}).message.notification,
    {title: 'Drumee', body: 'You have new activity'},
  );
});

test('carries the subtitle to iOS natively and as the first body line on Android', () => {
  const delivery = {
    event_id: 'event-1', type: 'channel.post', key_id: 'message-1', hub_id: 'hub-1',
    registration_id: 7, binding_version: 3, state_version: 4, expires_at: 123,
  };
  const payload = buildFcmMessage(delivery, 'token-value', {
    title: 'Temp Test', subtitle: 'To Marketing', body: 'draft is up',
  }).message;
  assert.deepEqual(payload.notification, {title: 'Temp Test', body: 'draft is up'});
  assert.deepEqual(payload.apns.payload.aps.alert, {title: 'Temp Test', subtitle: 'To Marketing', body: 'draft is up'});
  assert.equal(payload.apns.payload.aps['content-available'], 1);
  assert.equal(payload.android.notification.body, 'To Marketing\ndraft is up');

  const plain = buildFcmMessage(delivery, 'token-value', {title: 'Temp Test', body: 'lunch?'}).message;
  assert.deepEqual(plain.apns.payload.aps.alert, {title: 'Temp Test', body: 'lunch?'});
  assert.equal(plain.android.notification.body, undefined);
});

test('classifies retryable and token-invalid responses', () => {
  assert.equal(transientStatus(429), true);
  assert.equal(transientStatus(503), true);
  assert.equal(transientStatus(400), false);
  assert.equal(permanentFcmError(404, {}), false);
  assert.equal(permanentFcmError(400, {
    error: {details: [{
      '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
      errorCode: 'UNREGISTERED',
    }]},
  }), true);
  assert.equal(permanentFcmError(400, {
    error: {details: [{
      '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
      errorCode: 'INVALID_ARGUMENT',
    }]},
  }), true);
  assert.equal(permanentFcmError(400, {
    error: {details: [{
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      errorCode: 'INVALID_ARGUMENT',
    }]},
  }), false);
  assert.equal(permanentFcmError(400, {error: {status: 'INVALID_ARGUMENT'}}), false);
});

test('keeps FCM success state bounded and provider-response-free', () => {
  assert.deepEqual(fcmSuccessOutcome(), {sent: true});
  assert.ok(FCM_REQUEST_TIMEOUT_MS > 0);
  assert.ok(FCM_REQUEST_TIMEOUT_MS < 30000);
});

test('binds registration lookup to the authorized recipient uid', () => {
  assert.deepEqual(registrationLookupArgs({
    registration_id: 7,
    recipient_uid: 'recipient-1',
    binding_version: 3,
    state_version: 4,
  }), [7, 'recipient-1', 3, 4]);
});

test('advances registration pages with a monotonic id cursor', () => {
  assert.equal(nextRegistrationCursor([
    {registration_id: 7},
    {registration_id: 12},
  ], 7), 12);
  assert.equal(nextRegistrationCursor([{registration_id: 7}], 7), null);
  assert.equal(nextRegistrationCursor([], 7), null);
});
