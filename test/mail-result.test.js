const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NOT_DISPATCHED,
  NO_MTA,
  mailFailure,
} = require('../service/lib/mail-result');

test('a delivered send is not a failure', () => {
  assert.equal(mailFailure({recipient: ['a@b.com'], error: null}), null);
  assert.equal(mailFailure({recipient: 'a@b.com', error: null}), null);
});

test('names the recipients the MTA rejected', () => {
  assert.match(
    mailFailure({recipient: ['a@b.com'], error: ['a@b.com']}),
    /a@b\.com/,
  );
  assert.match(
    mailFailure({recipient: ['a@b.com', 'c@d.com'], error: ['c@d.com']}),
    /c@d\.com/,
  );
  // An error carried as a plain message, not a recipient list.
  assert.match(mailFailure({error: 'ECONNREFUSED'}), /ECONNREFUSED/);
});

// Messenger.send() returns `this._html` — a STRING — when getMTA() declines to
// build a transport (myDrumee.useEmail falsy). That is the shape that made the
// old `if (result && result.error)` guard unfireable.
test('a NO_MTA send is a failure, not a success', () => {
  assert.equal(mailFailure('<html>the rendered mail</html>'), NO_MTA);
  assert.equal(mailFailure(''), NOT_DISPATCHED);
});

// Messenger.dispatch() is fire-and-forget and always returns undefined.
test('an un-awaited dispatch is a failure, not a success', () => {
  assert.equal(mailFailure(undefined), NOT_DISPATCHED);
  assert.equal(mailFailure(null), NOT_DISPATCHED);
});

test('never reports success for a shape it does not understand', () => {
  for (const v of [0, 1, true, false, [], ['a@b.com']]) {
    assert.equal(mailFailure(v), NOT_DISPATCHED, JSON.stringify(v));
  }
});
