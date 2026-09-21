/**
 * Workspace-member capability gate — the SERVER half of the role model that
 * `ui/src/drumee/builtins/skeleton/toolkit/permission.js` defines for every
 * role selector (invite popup, workspace settings, manage-access):
 *
 *   view   privilege 0b000011   read
 *   chat   privilege 0b000111   read + download      <- "download" IS the chat bit
 *   edit   privilege 0b001111   read + download + write
 *   admin  privilege 0b011111   ... + admin
 *   owner  privilege 0b111111
 *
 * The ACL already enforces the write/delete/admin tiers (`src: "write"` is
 * 0b0001000, and a chat member's 0b000111 fails it). What the ACL cannot
 * express is the CHAT tier: `channel.post` must stay reachable for a chat
 * member but not for a view-only one, and both satisfy `src: "read"`. These
 * helpers close that gap at the service layer.
 *
 * 🚨 The bit values are written out literally, NOT read from
 * `Constants.permission`, on purpose. server-essentials 1.3.0 MOVED them
 * (download 2 -> 4, write 4 -> 8). Against an older package
 * `Constants.permission.download` still resolves to 2 — which is the READ bit —
 * so a view-only member (privilege 3) would satisfy `privilege & 2` and
 * silently gain chat. Pinning the values makes the gate independent of which
 * package version happens to be installed. (A stale 1.2.44 copy really does sit
 * in some working trees, so this is not hypothetical.)
 *
 * 🚨 NEVER gate chat on `Constants.permission.chat` (0b0000110 = read|download).
 * It OVERLAPS read, so `privilege & chat` is TRUTHY for a view-only member
 * (3 & 6 = 2) and the gate silently admits exactly the role it exists to
 * exclude. Use CAN_CHAT below — the single download bit:
 *     view 3 & 4 = 0  (refused)      chat 7 & 4 = 4  (allowed)
 * The same trap applies to the ACL `src` word: use "download", never "chat".
 */

const CAN_READ = 0b0000010;
// One bit, two names. Per the product decision, "may chat" and "may download"
// are the SAME right for a workspace member — a chat member sits above view and
// is allowed both. Both names are exported so call sites read as what they mean.
const CAN_DOWNLOAD = 0b0000100;
const CAN_CHAT = 0b0000100;
const CAN_WRITE = 0b0001000;
const CAN_ADMIN = 0b0010000;

/**
 * What a member is granted on the hidden chat staging folder
 * ('/__chat__/__upload__'), where an attachment is held before it becomes a
 * message. read + download + write, plus the low bit every stored role mask
 * carries. The grant is written with assign_via 'no_traversal', so it applies
 * to that one folder and user_permission will not let it reach anything
 * inside it.
 *
 * 🚨 Pinned here for the same reason every other value in this file is, and
 * this one has already moved twice. `Privilege.WRITE` resolves to 15 under
 * server-essentials 1.3.1 and to 7 under 1.3.6, which republished the
 * pre-1.3.0 layout. package.json asks for ^1.3.1, so a bare `npm install`
 * picks up 1.3.6 and a grant written from `Privilege.WRITE` would carry no
 * write bit at all -- the exact 403 this value exists to fix, reintroduced
 * by a dependency bump nobody connected to chat.
 */
const CHAT_UPLOAD_GRANT = 0b0001111;

/**
 * Does this stored privilege carry every bit of `bit`?
 *
 * Deliberately `(p & bit) === bit` rather than `!== 0`: for a multi-bit mask
 * the loose form is satisfied by a PARTIAL overlap, which is precisely how
 * `permission.chat` leaks to view-only members. Identical for single-bit masks,
 * strictly safer for anything else.
 */
function privilegeAllows(privilege, bit) {
  const p = Number(privilege) || 0;
  const b = Number(bit) || 0;
  if (!b) return false;
  return (p & b) === b;
}

// A node id as the platform mints them: 16 hex-ish chars. Anything else is a
// client-supplied oddity — we fall back to the hub root rather than interpolate
// it. Mirrors channel.js's FILE_THREAD_SELECTOR_RE discipline.
const NODE_ID_RE = /^[0-9a-zA-Z_-]{1,32}$/;

/**
 * The hub's ROOT node id, resolved the same way the ACL resolves it:
 * `mfs_home()` on the hub db (see server-core/lib/acl.js::check_env, which sets
 * `_start_with = 'mfs_home'` and reads `home.home_id`).
 *
 * Deliberately NOT `service.home_id`: despite `room.js`/`desk.js` reading that
 * property, nothing in server-core or server-essentials ever assigns it on a
 * service instance, so it is `undefined` there. Memoized per request so a chat
 * burst costs at most one extra proc call.
 */
async function hubRootId(service) {
  if (service.__memberCapRoot !== undefined) return service.__memberCapRoot;
  let root = null;
  try {
    const home = await service.db.await_proc("mfs_home");
    root = (home && home.home_id) || null;
  } catch (e) {
    root = null;
  }
  service.__memberCapRoot = root;
  return root;
}

/**
 * Resolve THIS caller's privilege on the node a hub-scoped request targets, and
 * test it against `bit`.
 *
 * Node resolution mirrors what the ACL itself does: the request's own `nid` when
 * it carries a well-formed one, else the hub root. Workspace-root chat sends
 * only `hub_id` (see ui widget/chat/index.js — `nid` is added only for a scoped
 * sub-folder thread), so the root fallback is the NORMAL path there, not an
 * edge case.
 *
 * Reads `mfs_access_node(uid, nid)` — the same authoritative read
 * `@drumee/server-core/lib/acl.js` and `channel.js::_resolveFileThreadAccess`
 * use. It returns only the CALLER's own privilege, so it can never elevate.
 *
 * SHARE SESSIONS ARE NOT TOUCHED. A DMZ / secure-share request carries a token
 * and its session is cookie-bound to the share CREATOR, so `this.uid` would
 * report the creator's full privilege and this check would be meaningless
 * anyway. Those paths have their own recipient-derived guards
 * (`media.js::_secureShareCapAllowed`, `service/lib/secure-share-write-guard`);
 * this helper defers to them by allowing immediately when a token is present.
 *
 * FAIL-OPEN on any resolution failure, by design: this gate is a NEW
 * restriction layered on top of the existing ACL, so "could not determine"
 * must reproduce today's behaviour exactly rather than lock out a legitimate
 * member on a transient DB error. Same posture as
 * `secure-share-write-guard`'s null verdict. The ACL still ran first.
 *
 * @param {object} service  the service instance (`this` in a service method)
 * @param {number} bit      one of the CAN_* masks above
 * @returns {Promise<boolean>} true -> may proceed; false -> caller must reject
 */
async function memberCan(service, bit) {
  try {
    // Share/DMZ recipient: governed by the secure-share guards, not by member
    // privilege. Allow here so this helper can never change those flows.
    if (service.input && service.input.get && service.input.get("token")) {
      return true;
    }

    let nid = (service.input && service.input.use("nid")) || "";
    nid = `${nid}`;
    if (!nid || !NODE_ID_RE.test(nid)) nid = await hubRootId(service);
    if (!nid) return true;

    const node = await service.db.await_proc("mfs_access_node", service.uid, `${nid}`.substr(0, 16));
    if (!node) return true;

    const privilege = node.privilege != null ? node.privilege : node.permission;
    if (privilege == null) return true;

    return privilegeAllows(privilege, bit);
  } catch (e) {
    if (service && service.warn) {
      service.warn("[member-capability] privilege resolution failed", e && e.message);
    }
    return true;
  }
}

module.exports = {
  CAN_READ,
  CHAT_UPLOAD_GRANT,
  CAN_DOWNLOAD,
  CAN_CHAT,
  CAN_WRITE,
  CAN_ADMIN,
  privilegeAllows,
  memberCan,
};
