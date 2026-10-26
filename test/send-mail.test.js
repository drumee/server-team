const assert = require('node:assert/strict');
const test = require('node:test');

const token = require('../service/lib/unsubscribe-token');
const {
  TRANSACTIONAL, NOTIFICATION, buildMailOptions, sendMail, textFromHtml,
} = require('../service/lib/send-mail');

const BASE = 'https://drumee.test/-';
const HTML = '<h1>Welcome</h1><p>Hello <a href="https://drumee.test/-/#/desk">Open Drumee</a></p>';

// A Messenger stand-in: the fields send-mail reads, an MTA that records or
// rejects, and Messenger.send()'s NO_MTA answer (the rendered HTML string).
function fakeMsg({ noMta = false, reject = [], recipient = 'ann@example.com', subject = 'Hi' } = {}) {
  const sent = [];
  return {
    sent,
    _html: HTML,
    _text: undefined,
    get: (k) => ({ recipient, subject })[k],
    getMTA: async () => (noMta ? null : {
      sendMail: async (opts) => {
        if (reject.includes(opts.to)) throw new Error('550 rejected');
        sent.push(opts);
      },
    }),
    send: async () => '<html>rendered</html>',
    warn: () => {},
  };
}

test.beforeEach(() => token._setSecretForTest('s'.repeat(40)));
test.after(() => token._setSecretForTest(undefined));

test('text part is generated from the HTML, headings not shouted', () => {
  const text = textFromHtml(HTML);
  assert.match(text, /Welcome/);
  assert.doesNotMatch(text, /WELCOME/);
  assert.match(text, /Open Drumee/);
  assert.match(text, /https:\/\/drumee\.test\/-\/#\/desk/);
});

// Email layouts use &nbsp; spacer cells; they must not become runs of blank,
// space-only lines in the text part (the invite mail had a dozen).
test('text part has no space-only lines and no double blank lines', () => {
  const html = '<p>Top</p><table><tr><td>&nbsp;</td></tr></table><div>&nbsp;</div>'
    + '<table><tr><td> &nbsp; </td></tr></table><p>Bottom</p>';
  const text = textFromHtml(html);
  assert.match(text, /Top/);
  assert.match(text, /Bottom/);
  for (const line of text.split('\n')) {
    assert.ok(line === '' || /\S/.test(line.replace(/\u00a0/g, ' ')), JSON.stringify(line));
  }
  assert.doesNotMatch(text, /\n\s*\n\s*\n/);
});

test('every mail: one brand From, Reply-To, a text part', () => {
  const o = buildMailOptions({ to: 'ann@example.com', subject: 'Hi', html: HTML });
  assert.equal(o.from, '"Drumee" <contact@drumee.org>');
  assert.equal(o.replyTo, 'contact@drumee.org');
  assert.equal(o.to, 'ann@example.com');
  assert.equal(o.html, HTML);
  assert.ok(o.text.length > 10);
});

test('an explicit text part is kept as given', () => {
  const o = buildMailOptions({ to: 'a@b.c', subject: 'Hi', html: HTML, text: 'Plain.' });
  assert.equal(o.text, 'Plain.');
});

test('transactional mail never carries List-Unsubscribe', () => {
  const o = buildMailOptions({ to: 'a@b.c', subject: 'Code', html: HTML, kind: TRANSACTIONAL, appBase: BASE });
  assert.equal(o.headers, undefined);
});

test('notification mail carries RFC 8058 one-click headers', () => {
  const o = buildMailOptions({ to: 'Ann@Example.com', subject: 'Activity', html: HTML, kind: NOTIFICATION, appBase: BASE });
  assert.equal(o.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const m = o.headers['List-Unsubscribe'].match(/^<(https:\/\/[^>]+)>$/);
  assert.ok(m, o.headers['List-Unsubscribe']);
  const u = new URL(m[1]);
  assert.equal(u.searchParams.get('service'), 'callback.unsubscribe');
  assert.equal(token.verify('ann@example.com', u.searchParams.get('sig')), true);
});

test('notification without a secret still sends, without the header', async () => {
  token._setSecretForTest(null);
  const o = buildMailOptions({ to: 'a@b.c', subject: 'Activity', html: HTML, kind: NOTIFICATION, appBase: BASE });
  assert.equal(o.headers, undefined);
});

test('missing body or an unknown kind throws', () => {
  assert.throws(() => buildMailOptions({ to: 'a@b.c', subject: 'x' }), /html or text/);
  assert.throws(() => buildMailOptions({ to: 'a@b.c', subject: 'x', html: HTML, kind: 'promo' }), /kind/);
});

test('sendMail reads recipient, subject and rendered template off the Messenger', async () => {
  const msg = fakeMsg();
  const res = await sendMail(msg);
  assert.deepEqual(res, { recipient: ['ann@example.com'], error: null });
  assert.equal(msg.sent.length, 1);
  assert.equal(msg.sent[0].subject, 'Hi');
  assert.equal(msg.sent[0].html, HTML);
});

test('one transaction per distinct recipient; only rejects are reported', async () => {
  const msg = fakeMsg({
    recipient: ['ann@example.com', ' ', 'bob@example.com', 'ann@example.com'],
    reject: ['bob@example.com'],
  });
  const res = await sendMail(msg);
  assert.deepEqual(msg.sent.map((o) => o.to), ['ann@example.com']);
  assert.deepEqual(res, { recipient: ['ann@example.com', 'bob@example.com'], error: ['bob@example.com'] });
});

test('no MTA: returns what Messenger.send returns (NO_MTA string)', async () => {
  const res = await sendMail(fakeMsg({ noMta: true }));
  assert.equal(res, '<html>rendered</html>');
});

test('a bad request throws before anything is sent', async () => {
  const msg = fakeMsg();
  msg._html = undefined;
  await assert.rejects(sendMail(msg), /html or text/);
  assert.equal(msg.sent.length, 0);
});

// A missing lexicon key used to send with an empty subject; refusing would
// turn a cosmetic gap into a 500 on password reset.
test('a missing subject still sends (empty subject), never throws', async () => {
  const msg = fakeMsg({ subject: null });
  const res = await sendMail(msg);
  assert.deepEqual(res, { recipient: ['ann@example.com'], error: null });
  assert.equal(msg.sent[0].subject, '');
});

// No address at all (a null row.email) must read as a failure, not a delivery.
test('no recipient is reported as a failure, nothing sent', async () => {
  for (const recipient of [null, '', [], ['  ']]) {
    const msg = fakeMsg({ recipient });
    const res = await sendMail(msg);
    assert.equal(msg.sent.length, 0);
    assert.ok(res && Array.isArray(res.error) && res.error.length, JSON.stringify(res));
  }
});
