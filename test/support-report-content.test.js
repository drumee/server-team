const assert = require('node:assert/strict');
const test = require('node:test');

global.myDrumee = {arch: 'pod', useEmail: 0};
global.verbosity = 0;
global.debug = {};

// The one seam: what the worker hands the mail layer, and what the mail layer
// answers. Stubbed before the worker is required so it binds to this copy.
const mail = {calls: [], answer: null};
const sendMailPath = require.resolve('../service/lib/send-mail');
require.cache[sendMailPath] = {
  id: sendMailPath,
  filename: sendMailPath,
  loaded: true,
  exports: {
    sendMail: async (msg, parts) => {
      mail.calls.push({recipient: msg.get('recipient'), subject: msg.get('subject'), ...parts});
      return mail.answer;
    },
  },
};

const SupportPrivate = require('../service/private/support');

function report(params, {anonymous = false} = {}) {
  const result = {errors: [], data: []};
  const worker = {
    uid: 'reporter-uid',
    session: {isAnonymous: () => anonymous},
    input: {get: (key) => params[key]},
    user: {get: (key) => ({email: 'alex@example.com', fullname: 'Alex Doe'})[key]},
    exception: {user: (code) => result.errors.push(code), email: () => undefined},
    output: {data: (data) => result.data.push(data)},
    warn: () => undefined,
  };
  return SupportPrivate.prototype.report_content.call(worker).then(() => result);
}

const message = {
  kind: 'message',
  target: {message_id: 'm1', author_id: 'peer-uid', excerpt: '<script>alert(1)</script>'},
};

test('a report is mailed to operations, and answers sent only when the mail was accepted', async () => {
  mail.calls.length = 0;
  mail.answer = {recipient: ['operation@drumee.org'], error: null};
  assert.deepEqual(await report(message), {errors: [], data: [{sent: 1}]});
  const [sent] = mail.calls;
  assert.equal(sent.recipient, 'operation@drumee.org');
  assert.match(sent.text, /Reported by: Alex Doe <alex@example\.com> \(reporter-uid\)/);
  assert.match(sent.text, /author_id: peer-uid/);
  // The excerpt is the reported user's own words: quoted, never rendered.
  assert.doesNotMatch(sent.html, /<script>/);
  assert.match(sent.html, /&lt;script&gt;/);

  // No MTA: sendMail returns the rendered HTML, which must not read as sent.
  mail.answer = '<html>rendered</html>';
  assert.deepEqual(await report(message), {errors: ['REPORT_NOT_SENT'], data: []});
});

test('a guest or a malformed report mails nobody', async () => {
  mail.calls.length = 0;
  assert.deepEqual((await report(message, {anonymous: true})).errors, ['NOT_SIGNED_IN']);
  assert.deepEqual((await report({kind: 'file', target: {}})).errors, ['INVALID_REPORT']);
  assert.deepEqual((await report({kind: 'contact', target: 'c1'})).errors, ['INVALID_REPORT']);
  assert.equal(mail.calls.length, 0);
});
