const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isPendingCancel, clearCancelParams, endSubscription, endSubscriptionsOf,
} = require('../service/lib/subscription-cancel');

// Records every Stripe call; `subs` maps id -> live subscription.
function fakeStripe(subs, openInvoices = {}) {
  const calls = [];
  const missing = (id) => Object.assign(new Error(`No such subscription: '${id}'`), { code: 'resource_missing' });
  return {
    calls,
    subscriptions: {
      retrieve: async (id) => { calls.push(['retrieve', id]); if (!subs[id]) throw missing(id); return subs[id]; },
      update: async (id, p) => { calls.push(['update', id, p]); return { ...subs[id], ...p }; },
      cancel: async (id) => { calls.push(['cancel', id]); return { ...subs[id], status: 'canceled', cancel_at: null }; },
    },
    invoices: {
      list: async (p) => { calls.push(['list', p.subscription, p.status]); return { data: openInvoices[p.subscription] || [] }; },
      voidInvoice: async (id) => { calls.push(['void', id]); return { id, status: 'void' }; },
    },
  };
}

test('a pending cancel is either cancel_at_period_end or a Portal cancel_at date', () => {
  assert.equal(isPendingCancel({ cancel_at_period_end: true, cancel_at: 1 }), true);
  assert.equal(isPendingCancel({ cancel_at_period_end: false, cancel_at: 1795234247 }), true);
  assert.equal(isPendingCancel({ cancel_at_period_end: false, cancel_at: null }), false);
  assert.equal(isPendingCancel(null), false);
});

test('clearing a cancel never sends both params (Stripe rejects that)', () => {
  assert.deepEqual(clearCancelParams({ cancel_at_period_end: false, cancel_at: 1795234247 }), { cancel_at: '' });
  assert.deepEqual(clearCancelParams({ cancel_at_period_end: true, cancel_at: 1795234247 }), { cancel_at_period_end: false });
  assert.deepEqual(clearCancelParams({ cancel_at_period_end: false, cancel_at: null }), { cancel_at_period_end: false });
});

test('a paid-up subscription ends at period end and is not voided', async () => {
  const stripe = fakeStripe({ s1: { id: 's1', status: 'active', cancel_at_period_end: false, cancel_at: null } });
  const r = await endSubscription(stripe, 's1');
  assert.equal(r.ended, false);
  assert.deepEqual(stripe.calls, [['retrieve', 's1'], ['update', 's1', { cancel_at_period_end: true }]]);
});

test('an already scheduled cancel keeps the date the customer chose', async () => {
  const stripe = fakeStripe({ s1: { id: 's1', status: 'active', cancel_at_period_end: false, cancel_at: 1795234247 } });
  const r = await endSubscription(stripe, 's1');
  assert.equal(r.ended, false);
  assert.deepEqual(stripe.calls, [['retrieve', 's1']]);
});

test('an unpaid renewal ends now, cancelling before voiding the open invoice', async () => {
  const stripe = fakeStripe(
    { s1: { id: 's1', status: 'past_due', cancel_at_period_end: false, cancel_at: 1795234247 } },
    { s1: [{ id: 'in_1' }] },
  );
  const r = await endSubscription(stripe, 's1');
  assert.equal(r.ended, true);
  assert.deepEqual(stripe.calls, [['retrieve', 's1'], ['cancel', 's1'], ['list', 's1', 'open'], ['void', 'in_1']]);
});

test('an already ended subscription is reported ended without any write', async () => {
  const stripe = fakeStripe({ s1: { id: 's1', status: 'canceled' } });
  const r = await endSubscription(stripe, 's1');
  assert.equal(r.ended, true);
  assert.deepEqual(stripe.calls, [['retrieve', 's1']]);
});

test('account deletion stops the personal and the owned org subscription', async () => {
  const stripe = fakeStripe({
    personal: { id: 'personal', status: 'active' },
    org: { id: 'org', status: 'past_due' },
  });
  const yp = {
    await_proc: async (proc, id) => {
      if (proc === 'payment_get_subscription') return { subscription_id: id === 'u1' ? 'personal' : 'org' };
      if (proc === 'payment_get_org') return { id: 'o1' };
      return null;
    },
  };
  assert.equal(await endSubscriptionsOf(yp, stripe, 'u1'), 2);
  assert.deepEqual(stripe.calls.filter((c) => c[0] !== 'retrieve' && c[0] !== 'list').map((c) => c.slice(0, 2)),
    [['update', 'personal'], ['cancel', 'org']]);
});

test('account deletion with no subscription makes no Stripe call', async () => {
  const stripe = fakeStripe({});
  const yp = { await_proc: async () => null };
  assert.equal(await endSubscriptionsOf(yp, stripe, 'u1'), 0);
  assert.deepEqual(stripe.calls, []);
});

test('a subscription Stripe no longer has does not block the deletion', async () => {
  const stripe = fakeStripe({});
  const yp = { await_proc: async (proc) => (proc === 'payment_get_subscription' ? { subscription_id: 'gone' } : null) };
  assert.equal(await endSubscriptionsOf(yp, stripe, 'u1'), 1);
});

test('any other Stripe failure propagates so the deletion is refused', async () => {
  const stripe = fakeStripe({});
  stripe.subscriptions.retrieve = async () => { throw new Error('connection reset'); };
  const yp = { await_proc: async (proc) => (proc === 'payment_get_subscription' ? { subscription_id: 's1' } : null) };
  await assert.rejects(endSubscriptionsOf(yp, stripe, 'u1'), /connection reset/);
});
