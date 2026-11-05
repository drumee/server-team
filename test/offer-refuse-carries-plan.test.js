// A once_per_card refusal (OFFER_CARD_USED) tells the result modal which
// checkout to reopen: plan + period ride back with the status, so "Use another
// card" / "Continue at regular price" land on the same Team monthly checkout.
//
//   node --test test/offer-refuse-carries-plan.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { offerFinalize } = require("../service/lib/offer");

function ctxFor({ checkError = "OFFER_CARD_USED" } = {}) {
  const procs = [];
  const stripe = {
    subscriptions: { list: async () => ({ data: [] }) },
    setupIntents: {
      retrieve: async () => ({ payment_method: { id: "pm_1", card: { fingerprint: "fp_used", last4: "4444" } } }),
    },
  };
  return {
    procs,
    uid: "u1",
    stripe: () => stripe,
    yp: {
      async await_proc(name, ...args) {
        procs.push([name, ...args]);
        if (name === "payment_get_payer") return { email: "a@b.com" };
        if (name === "mkt_offer_check") return [{ error: checkError }];
        if (name === "mkt_offer_release") return [{}];
        throw new Error(`unexpected proc ${name}`);
      },
    },
  };
}

const session = {
  id: "cs_test_1",
  status: "complete",
  customer: "cus_1",
  setup_intent: "seti_1",
  metadata: {
    payer_id: "u1", plan: "team", period: "month",
    mkt_code: "TEAM1", mkt_redemption_id: "87", offer_setup: "1",
  },
};

test("OFFER_CARD_USED comes back with the offer code, plan and period", async () => {
  const ctx = ctxFor();
  const res = await offerFinalize(ctx, session);
  assert.deepEqual(res, {
    status: "OFFER_CARD_USED",
    payment_status: "unpaid",
    offer_code: "TEAM1",
    plan: "team",
    period: "month",
  });
  assert.ok(ctx.procs.some((p) => p[0] === "mkt_offer_release" && p[1] === 87), "hold released");
});
