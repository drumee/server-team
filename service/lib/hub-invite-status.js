/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * Where a workspace invitation stands, read off its token.
 *
 * WHY THE FEED NEEDS THIS. Answering an invitation stamps `dismissed_at` on its
 * notification (contact_activity_dismiss_hub_invite), and dismissal is only
 * "acknowledged": the row stays in the activity history on purpose. But the row
 * still carries the invitation's secret, and the client draws Accept/Decline
 * for any row that has one — so after a Decline the row came back from the
 * refresh exactly as it was, Decline pressed again did nothing, and Accept
 * reported an invalid link. `dismissed_at` cannot tell the client "answered"
 * either: marking a row read writes the same column.
 *
 * The token is the one place that knows, and it is what both answers write.
 *
 *   pending    active and not expired — the only state that is answerable
 *   accepted   the invitation was taken up (including by somebody who already
 *              held the access it offered — accept_invite redeems it anyway)
 *   declined   turned down
 *   expired    active, but past its expiry: accept_invite would say `expired`
 *   invalid    no such token any more (swept on expiry, or superseded by a
 *              newer invitation to the same person), or not a hub_invite token
 *              for this workspace
 *
 * The expiry rule is accept_invite's own (`expiry > 0 && now > expiry`), so the
 * row can never offer an answer the service would then refuse.
 *
 * @param {object|null} tokenRow  a row of yp.token_get_next, or nothing
 * @param {string}      hub_id    the workspace the notification names
 * @param {number}      now       unix seconds
 * @returns {'pending'|'accepted'|'declined'|'expired'|'invalid'}
 */
function hubInviteStatus(tokenRow, hub_id, now) {
  if (!tokenRow || !tokenRow.secret) return 'invalid';
  const method = String(tokenRow.method || '');
  if (!method.startsWith('hub_invite:')) return 'invalid';
  if (hub_id && method.slice('hub_invite:'.length) !== String(hub_id)) return 'invalid';
  switch (tokenRow.status) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'active': {
      const expiry = Number(tokenRow.expiry) || 0;
      return expiry > 0 && now > expiry ? 'expired' : 'pending';
    }
    default:
      return 'invalid';
  }
}

module.exports = { hubInviteStatus };
