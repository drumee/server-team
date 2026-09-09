

  // Recurring messages that aren't actionable Drumee bugs: wallet/dApp provider
  // collisions, benign ResizeObserver loop warnings, and aborted fetches.
  const NOISE_MESSAGES = [
    /Cannot redefine property:\s*(ethereum|solana|web3|tron(Link|Web)?|keplr)/i,
    /Cannot (set|assign to read only) property '?(ethereum|solana)'?/i,
    /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
    /AbortError|The (operation was aborted|user aborted a request)/i,
  ];

  const isExtensionNoise = function (url, stack, msg) {
    // Errors raised by browser extensions (e.g. wallet content scripts racing
    // to define window.ethereum) come from the user's browser, not from Drumee.
    // Anywhere in url+stack, not only at the start: an extension hooking a page
    // callback throws with the PAGE as url and the extension frame further down
    // the stack. The server drops those (same test, unanchored); matching here
    // stops the client from posting them at all.
    if (/(chrome|moz|safari(-web)?)-extension:\/\//.test((url || '') + (stack || ''))) return true;
    // Some extensions throw with no extension frame in the stack — match the
    // recurring message text as a fallback.
    return msg != null && NOISE_MESSAGES.some(function (re) { return re.test(msg); });
  };

  // One report per distinct error per page, and a hard budget per page: a page
  // stuck in an error loop (a throw per animation frame, per timer tick, per
  // reconnect) posted one request per throw with nothing to stop it -- 23/s
  // for hours from a single tab on 2026-09-09. The first occurrence is what a
  // developer needs; the rest only load the server.
  const REPORT_BUDGET = 20;          // per page load
  const REPORT_WINDOW_MS = 60000;    // budget refills once per minute
  const seenErrors = new Set();
  let reportsInWindow = 0;
  let windowStart = Date.now();
  const reportError = function (payload) {
    const key = [payload.msg, payload.url, payload.line, payload.col].join('|').slice(0, 500);
    if (seenErrors.has(key)) return;
    const now = Date.now();
    if (now - windowStart > REPORT_WINDOW_MS) { windowStart = now; reportsInWindow = 0; }
    if (reportsInWindow >= REPORT_BUDGET) return;
    reportsInWindow++;
    if (seenErrors.size < 500) seenErrors.add(key);
    fetch('<%= svcPath %>bootstrap.report_error', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    }).catch(function () { /* reporting must never itself become an error */ });
  };

  window.onerror = function (msg, url, line, col, error) {
    // Ignore extension noise and opaque cross-origin "Script error." entries.
    if (isExtensionNoise(url, error?.stack, msg)) return;
    if (msg === 'Script error.' && !url) return;
    reportError({ msg, url, line, col, stack: error?.stack });
  };

  window.addEventListener('unhandledrejection', function (event) {
    const reason = event?.reason;
    const stack = reason?.stack;
    const msg = reason?.message || String(reason);
    // Extensions reject promises too (dApp provider injection etc.) — skip them.
    if (isExtensionNoise(stack, stack, msg)) return;
    reportError({ msg, url: 'unhandledrejection', stack });
  });

