const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createDeviceRegistrationV2,
  deviceRegistrationV2Statement,
} = require('../service/lib/device-registration-v2');

test('preserves SQL nulls for an initial v2 registration CAS tuple', async () => {
  let call;
  const yp = {
    async await_run(...args) {
      call = args;
      return [{registration_id: 7}];
    },
  };

  const rows = await createDeviceRegistrationV2(yp, {
    uid: 'recipient-1',
    registrationKind: 'token',
    registrationDigest: 'a'.repeat(64),
    pushToken: 'fcm-token',
    deviceId: 'device-1',
    deviceType: 'android',
    registrationId: null,
    bindingVersion: null,
    stateVersion: null,
  });

  assert.deepEqual(rows, [{registration_id: 7}]);
  assert.deepEqual(call, [
    {sql: deviceRegistrationV2Statement, logParam: false},
    [
      'recipient-1',
      'token',
      'a'.repeat(64),
      'fcm-token',
      'device-1',
      'android',
      null,
      null,
      null,
    ],
  ]);
});

test('keeps the push token out of database failure details', async () => {
  const pushToken = 'sensitive-registration-token';
  const yp = {
    async await_run(query) {
      assert.equal(query.logParam, false);
      const error = new Error(`registration failed for ${pushToken}`);
      error.code = 'ER_TEST';
      error.sql = `${query.sql} -- ${pushToken}`;
      error.sqlMessage = `invalid value ${pushToken}`;
      error.parameters = [pushToken];
      error.cause = {token: pushToken};
      throw error;
    },
  };

  await assert.rejects(
    createDeviceRegistrationV2(yp, {
      uid: 'recipient-1',
      registrationKind: 'token',
      registrationDigest: 'a'.repeat(64),
      pushToken,
      deviceId: 'device-1',
      deviceType: 'android',
      registrationId: null,
      bindingVersion: null,
      stateVersion: null,
    }),
    error => {
      assert.equal(JSON.stringify({
        message: error.message,
        ...error,
      }).includes(pushToken), false);
      assert.equal(error.message, 'Device registration database request failed');
      assert.equal(error.code, 'ER_TEST');
      assert.equal('sql' in error, false);
      assert.equal('cause' in error, false);
      return true;
    },
  );
});
