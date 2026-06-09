

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
    if (/^(chrome|moz|safari(-web)?)-extension:\/\//.test((url || '') + (stack || ''))) return true;
    // Some extensions throw with no extension frame in the stack — match the
    // recurring message text as a fallback.
    return msg != null && NOISE_MESSAGES.some(function (re) { return re.test(msg); });
  };

  const reportError = function (payload) {
    fetch('<%= svcPath %>bootstrap.report_error', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });
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

