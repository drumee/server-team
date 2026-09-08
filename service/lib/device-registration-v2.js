const deviceRegistrationV2Statement =
  'CALL device_registration_v2(?, ?, ?, ?, ?, ?, ?, ?, ?)';

async function createDeviceRegistrationV2(yp, registration) {
  // await_proc rewrites null to an empty string and its debug formatter would
  // interpolate the raw token. The MariaDB query option preserves bound SQL
  // values and prevents the driver from rendering parameters into error.sql.
  try {
    return await yp.await_run(
      {sql: deviceRegistrationV2Statement, logParam: false},
      [
      registration.uid,
      registration.registrationKind,
      registration.registrationDigest,
      registration.pushToken,
      registration.deviceId,
      registration.deviceType,
      registration.registrationId,
      registration.bindingVersion,
      registration.stateVersion,
      ],
    );
  } catch (error) {
    // Do not propagate driver fields: sql, parameters, or nested causes can
    // retain the raw token even when their visible message looks harmless.
    const safeError = new Error('Device registration database request failed');
    safeError.code = String(error?.code || 'DB_REQUEST_FAILED')
      .replace(/[^0-9A-Za-z_.-]/g, '_')
      .slice(0, 64);
    safeError.sqlState = String(error?.sqlState || '')
      .replace(/[^0-9A-Za-z]/g, '')
      .slice(0, 16);
    throw safeError;
  }
}

module.exports = {
  createDeviceRegistrationV2,
  deviceRegistrationV2Statement,
};
