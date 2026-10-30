const test = require('node:test');
const assert = require('node:assert');
const { stripeEventsFor, gaPayload, offerForCheckout, emit, OFFERS } = require('../../service/lib/campaign');

const md = { offer: 'team-1usd', plan: 'team', payer_id: 'u1' };
const ev = (type, object, id = 'evt_1') => ({ id, type, data: { object } });

test('no offer, no events', () => {
  assert.deepStrictEqual(stripeEventsFor(ev('invoice.paid', { billing_reason: 'subscription_cycle', amount_paid: 2900 }), {}), []);
});

test('card_added only once the checkout is actually paid', () => {
  assert.deepStrictEqual(stripeEventsFor(ev('checkout.session.completed', { payment_status: 'unpaid' }), md), []);
  assert.strictEqual(stripeEventsFor(ev('checkout.session.completed', { payment_status: 'paid' }), md)[0].event, 'card_added_1usd');
});

test('card_failed records every attempt, and only on the first invoice', () => {
  const a = stripeEventsFor(ev('invoice.payment_failed', { billing_reason: 'subscription_create' }, 'evt_a'), md)[0];
  const b = stripeEventsFor(ev('invoice.payment_failed', { billing_reason: 'subscription_create' }, 'evt_b'), md)[0];
  assert.notStrictEqual(a.slot, b.slot);
  assert.deepStrictEqual(stripeEventsFor(ev('invoice.payment_failed', { billing_reason: 'subscription_cycle' }), md), []);
});

test('renew_29 needs a real $29 renewal', () => {
  assert.strictEqual(stripeEventsFor(ev('invoice.paid', { billing_reason: 'subscription_cycle', amount_paid: 2900 }), md)[0].event, 'renew_29');
  assert.deepStrictEqual(stripeEventsFor(ev('invoice.paid', { billing_reason: 'subscription_create', amount_paid: 100 }), md), []);
  assert.deepStrictEqual(stripeEventsFor(ev('invoice.paid', { billing_reason: 'subscription_cycle', amount_paid: 9900 }), md), []);
});

test('subscription_cancelled', () => {
  assert.strictEqual(stripeEventsFor(ev('customer.subscription.deleted', {}), md)[0].event, 'subscription_cancelled');
});

test('GA payload clips to 100 chars, and falls back to a stable client id', () => {
  const p = gaPayload({ uid: 'u1', event: 'renew_29', offer: 'team-1usd', ctime: 1000, gclid: 'x'.repeat(300), org_id: 'o1', country: 'CH' });
  assert.strictEqual(p.client_id, 'srv.u1');
  assert.strictEqual(p.events[0].params.gclid.length, 100);
  assert.strictEqual(p.events[0].params.workspace_id, 'o1');
  assert.strictEqual(p.events[0].params.plan, 'team');
  assert.strictEqual(p.timestamp_micros, 1000000000);
  assert.ok(Object.keys(p.events[0].params).length <= 25);
  assert.strictEqual(gaPayload({ uid: 'u1', ga_client_id: '1.2', event: 'e', ctime: 1 }).client_id, '1.2');
});

const yp = (row) => ({ await_query: async () => row });

test('the $1 price is decided from stored attribution, and only once', async () => {
  const before = OFFERS['team-1usd'].ends_at - 1000;
  assert.strictEqual((await offerForCheckout(yp({ offer: 'team-1usd', used: 0 }), 'u', 'team', 'month', before)).amount_off, 2800);
  assert.strictEqual(await offerForCheckout(yp({ offer: 'team-1usd', used: 1 }), 'u', 'team', 'month', before), null);
  assert.strictEqual(await offerForCheckout(yp({ offer: 'other', used: 0 }), 'u', 'team', 'month', before), null);
  assert.strictEqual(await offerForCheckout(yp(undefined), 'u', 'team', 'month', before), null);
  assert.strictEqual(await offerForCheckout(yp({ offer: 'team-1usd', used: 0 }), 'u', 'team', 'year', before), null);
  assert.strictEqual(await offerForCheckout(yp({ offer: 'team-1usd', used: 0 }), 'u', 'business', 'month', before), null);
  assert.strictEqual(await offerForCheckout(yp({ offer: 'team-1usd', used: 0 }), 'u', 'team', 'month', before + 2000), null);
});

test('a database failure never reaches the caller', async () => {
  const broken = { await_query: async () => { throw new Error('no table'); } };
  await emit(broken, 'u', 'space_created');
  assert.strictEqual(await offerForCheckout(broken, 'u', 'team', 'month'), null);
});
