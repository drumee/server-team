/**
 * Download permission gate — lets a page start several downloads only once
 * the user has answered the browser's "allow multiple downloads" prompt.
 *
 * A page may start ONE download on its own; the browser holds every further
 * one behind that prompt, and requests it only once the user allows it. So:
 *  - the first item is requested through `hold`: the request is parked here,
 *    headers unsent, so the browser lists nothing yet — but it has spent the
 *    page's one free download;
 *  - the second item, through `open`: the browser holds it behind the prompt.
 *    It reaches the server only when the user says yes: `open` marks the gate
 *    open, and both requests are redirected to their real files.
 * The page polls `state` to learn the answer, and calls it with cancel when
 * the user gives up (or never answers): the parked request then ends empty.
 *
 * The two requests can land on different service workers: the gate lives in
 * Redis.
 */
const KEY = "dl-gate:";
const TTL = 30 * 60; // seconds
const OPEN = "open";
const CANCEL = "cancel";
// nginx ends a proxied request silent for 60s: a parked one is answered just
// before, with a redirect to itself — the browser follows up to 20 of them.
const HOLD_MS = 45 * 1000;
const POLL_MS = 250;
const MAX_HOPS = 18;

const key = (uid, gate) => `${KEY}${uid}:${gate}`;

/**
 * A gate id is the page's own random token.
 */
function validGate(gate) {
  return typeof gate === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(gate);
}

/**
 * Where a gated request is redirected: a path on this origin, nothing else.
 */
function validTarget(to) {
  return typeof to === "string" && /^\/(?![\/\\])[^\s]*$/.test(to);
}

/**
 * The page asks: has the user answered yet?
 * @returns {Promise<string>} "open" | "cancel" | ""
 */
async function state(client, uid, gate) {
  return (await client.get(key(uid, gate))) || "";
}

async function mark(client, uid, gate, value) {
  // Never undo an answer: an opened gate stays open, a cancelled one closed.
  await client.set(key(uid, gate), value, { EX: TTL, NX: true });
  return state(client, uid, gate);
}

/**
 * Park until the gate is answered, or `wait_ms` passes.
 * @returns {Promise<string>} "open" | "cancel" | "" (still unanswered)
 */
async function hold(client, uid, gate, { wait_ms = HOLD_MS, poll_ms = POLL_MS, sleep, isGone } = {}) {
  const until = Date.now() + wait_ms;
  for (;;) {
    const s = await state(client, uid, gate);
    if (s) return s;
    if (Date.now() >= until) return "";
    if (isGone && isGone()) return CANCEL;
    await sleep(poll_ms);
  }
}

/**
 * The same request again, one hop further: the redirect a parked request
 * answers with just before nginx would cut it.
 */
function nextHop(url) {
  const [path, query = ""] = String(url).split("?");
  const params = new URLSearchParams(query);
  const hop = (Number(params.get("hop")) || 0) + 1;
  if (hop > MAX_HOPS) return null;
  params.set("hop", String(hop));
  return `${path}?${params.toString()}`;
}

module.exports = {
  KEY, TTL, OPEN, CANCEL, HOLD_MS, POLL_MS, MAX_HOPS,
  key, validGate, validTarget, state, mark, hold, nextHop,
};
