const {privilegeAllows} = require('./mobile-push-recipients');

const DB_NAME = /^[0-9a-zA-Z_]+$/;
const CAN_READ = 0b0000010;
const CAN_CHAT = 0b0000100;

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function createMobilePushAuthorization(yp) {
  async function directChatAllowed(event, recipientUid) {
    if (event.type !== 'chat.post') return true;
    const actorId = String(event.actor_id || '');
    const uid = String(recipientUid || '');
    if (!actorId || !uid || actorId === uid) return false;
    const [actor, recipient] = await Promise.all([
      yp.await_proc('drumate_exists', actorId),
      yp.await_proc('drumate_exists', uid),
    ]);
    if (!asArray(actor).length || !asArray(recipient).length) return false;
    const blocked = asArray(await yp.await_query(
      `SELECT 1 AS blocked FROM contact_block
        WHERE (owner_id=? AND (uid=? OR entity=?))
           OR (owner_id=? AND (uid=? OR entity=?))
        LIMIT 1`,
      actorId, uid, uid, uid, actorId, actorId,
    ));
    return blocked.length === 0;
  }

  async function hubRecipientAllowed(event, recipientUid) {
    const hubId = String(event.hub_id || '');
    const uid = String(recipientUid || '');
    if (!hubId || !uid) return false;
    const entity = asArray(await yp.await_query(
      'SELECT db_name FROM entity WHERE id=? LIMIT 1',
      hubId,
    ))[0];
    const dbName = String(entity && entity.db_name || '');
    if (!DB_NAME.test(dbName)) return false;
    const member = asArray(await yp.await_query(
      `SELECT permission AS privilege FROM \`${dbName}\`.permission
        WHERE resource_id='*' AND entity_id=?
          AND (expiry_time=0 OR expiry_time>UNIX_TIMESTAMP())
        LIMIT 1`,
      uid,
    ))[0];
    const required = event.type === 'channel.post' ? CAN_CHAT : CAN_READ;
    if (!member || !privilegeAllows(member.privilege, required)) return false;
    if (!event.scope_nid) return true;
    const node = asArray(await yp.await_proc(
      'forward_proc',
      hubId,
      'mfs_access_node',
      `'${uid}','${event.scope_nid}'`,
    ))[0];
    return !!node && privilegeAllows(
      node.privilege ?? node.permission,
      required,
    );
  }

  async function recipientAllowed(event, recipientUid) {
    return event.hub_id
      ? hubRecipientAllowed(event, recipientUid)
      : directChatAllowed(event, recipientUid);
  }

  return {directChatAllowed, hubRecipientAllowed, recipientAllowed};
}

module.exports = {createMobilePushAuthorization};
