// service/lib/password-policy.js
// The one password policy for every endpoint that sets a password: signup,
// drumate.change_password and drumate.set_initial_password.
//
// KEEP IN STEP with PW_RULES in the signup UI (signup/src/widgets/form/index.js)
// and the settings change-password modal
// (ui-team/src/drumee/builtins/widget/settings/password-policy.js). The UIs
// check first for the inline message; this is the authoritative check, since
// the endpoints can be called directly. Keys double as the UIs' LOCALE keys
// for the "Your password still needs: …" list.

const PW_SPECIALS = /[\[\]\{\}\'\"\ \-\_\+\=\|\!\:\;\,\?\.\/\*\%\$\&\#\(\)\@]/;

const PW_RULES = [
  { key: "PW_NEEDS_MIN", test: (v) => v.length >= 8 },
  { key: "PW_NEEDS_UPPERCASE", test: (v) => /[A-Z]/.test(v) },
  { key: "PW_NEEDS_NUMBER", test: (v) => /[0-9]/.test(v) },
  { key: "PW_NEEDS_SYMBOL", test: (v) => PW_SPECIALS.test(v) },
];

/**
 * @param {String} password already trimmed by the caller (login trims too)
 * @returns {String[]} keys of the unmet rules, empty when compliant
 */
function missingPasswordRules(password) {
  const v = String(password == null ? "" : password);
  return PW_RULES.filter((r) => !r.test(v)).map((r) => r.key);
}

module.exports = { PW_SPECIALS, PW_RULES, missingPasswordRules };
