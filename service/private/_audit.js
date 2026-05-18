/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * Wrapper around `<db>.hub_add_action_log` for service handlers.
 * Never throws — audit failures must not break the calling mutation.
 * `ctx` is the handler `this` (needs `yp.await_proc`).
 */
async function writeAudit(ctx, opts) {
  if (!ctx || !ctx.yp || typeof ctx.yp.await_proc !== 'function') return;
  const {
    db, uid, action, category,
    notify_to = 'all',
    entity_id = null,
    log = '',
  } = opts || {};
  if (!db || !uid || !action || !category) {
    if (ctx.warn) ctx.warn('audit.writeAudit: missing required field', opts);
    return;
  }
  try {
    await ctx.yp.await_proc(
      `${db}.hub_add_action_log`,
      uid, action, category, notify_to, entity_id, String(log).slice(0, 1000)
    );
  } catch (e) {
    if (ctx.warn) ctx.warn('audit.writeAudit failed', { db, action, category, error: e && e.message });
  }
}

module.exports = { writeAudit };
