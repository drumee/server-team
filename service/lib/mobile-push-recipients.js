const BROADCAST_EVENTS = new Set(['channel.post']);
// Chat pushes the user can mute (activity.mute_set / mute_peer_set). Tasks,
// mentions in tasks and meeting reminders are not chat and keep ringing, and
// so does an instant-meeting card posted in a muted chat (see unmutedUids).
const MUTABLE_EVENTS = new Set(['chat.post', 'channel.post']);
// Pushes addressed to named people only, whatever their hub_id: a call rings
// the callee, and a 1:1 call's hub_id is the caller's own uid, not a hub whose
// members could be listed.
const DIRECT_EVENTS = new Set(['conference.invite']);
const MAX_RECIPIENTS = 100;
const MEMBER_PAGE_SIZE = 45;
const CAN_READ = 0b0000010;
const CAN_CHAT = 0b0000100;

function privilegeAllows(privilege, bit) {
  const value = Number(privilege) || 0;
  return (value & bit) === bit;
}

function hubMemberPageArguments(page) {
  const boundedPage = Math.max(1, Math.trunc(Number(page) || 1));
  return `${boundedPage},${MEMBER_PAGE_SIZE}`;
}

function activeHubMemberUids(event, rows, now = Math.floor(Date.now() / 1000)) {
  const required = event.type === 'channel.post' ? CAN_CHAT : CAN_READ;
  return rows
    .filter(row => {
      const expiry = Number(row && (row.expiry ?? row.expiry_time)) || 0;
      const privilege = row && (row.privilege ?? row.permission);
      return (!expiry || expiry > now) && privilegeAllows(privilege, required);
    })
    .map(row => String(row.id || ''))
    .filter(Boolean);
}

async function pagedHubMembers(fetchPage) {
  const members = [];
  const seen = new Set();
  const maxPages = Math.ceil(MAX_RECIPIENTS / MEMBER_PAGE_SIZE);
  for (let page = 1; page <= maxPages && members.length < MAX_RECIPIENTS; page += 1) {
    const rows = await fetchPage(page);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      const uid = row && String(row.id || '');
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      members.push(row);
      if (members.length >= MAX_RECIPIENTS) break;
    }
    if (rows.length < MEMBER_PAGE_SIZE) break;
  }
  return members;
}

function eligibleRecipientUids(event, currentHubUids = []) {
  const actorId = String(event.actor_id || '');
  const explicit = new Set(
    (event.recipient_uids || [])
      .map(String)
      .filter(uid => uid && uid !== actorId),
  );

  if (!event.hub_id || DIRECT_EVENTS.has(event.type)) return [...explicit].slice(0, MAX_RECIPIENTS);

  const current = new Set(
    currentHubUids.map(String).filter(uid => uid && uid !== actorId),
  );
  const candidates = BROADCAST_EVENTS.has(event.type)
    ? current
    : new Set([...explicit].filter(uid => current.has(uid)));
  return [...candidates].slice(0, MAX_RECIPIENTS);
}

/**
 * Drop the recipients who muted this chat push. `mutedRows` is the result of
 * yp.notification_muted_uids; anything but rows filters nothing (fail open:
 * a lookup that broke must not silence a phone). `isMeeting` marks an
 * instant-meeting start/end card: muting a chat silences its messages, not the
 * meetings started in it, which the Notification Center keeps showing too.
 */
function unmutedUids(event, uids, mutedRows, isMeeting = false) {
  if (!MUTABLE_EVENTS.has(event && event.type) || isMeeting) return uids;
  const muted = new Set(
    (Array.isArray(mutedRows) ? mutedRows : [])
      .map(row => String((row && row.uid) || ''))
      .filter(Boolean),
  );
  return muted.size ? uids.filter(uid => !muted.has(String(uid))) : uids;
}

module.exports = {
  BROADCAST_EVENTS,
  DIRECT_EVENTS,
  MUTABLE_EVENTS,
  MEMBER_PAGE_SIZE,
  MAX_RECIPIENTS,
  activeHubMemberUids,
  eligibleRecipientUids,
  hubMemberPageArguments,
  pagedHubMembers,
  privilegeAllows,
  unmutedUids,
};
