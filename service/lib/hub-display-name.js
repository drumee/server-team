/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3
 */

/**
 * The name a workspace should be CALLED BY when we write about it -- an invite
 * email, the message that rides the invitation, an audit line, the workspace
 * name stored on a notification.
 *
 * There is exactly one source for it: **`yp.hub.name`**, which `mfs_home`
 * returns as `name`. Every other candidate on a hub record is the hex id
 * wearing a friendly column name, and that is the whole reason this exists:
 *
 *   yp.hub.hubname          the hex id. Entity.get(Attr.name) resolves to it,
 *                           because a session's `hub` is loaded from yp.get_hub
 *                           and that procedure selects
 *                           `IF(_exists, h.hubname, _org_name) AS name` --
 *                           it never exposes h.name at all.
 *   get_hub().hubname/.name same two columns, same trap, one call further away.
 *
 * So `hub.invite` read mfs_home and mailed "Lexis added you to team Marketing",
 * while `hub.add_contributors` and `hub.invite_with_roles` read the hub record
 * and mailed "Lexis added you to team 218881d8218881dc" -- and
 * add_contributors stored that same hex id as the workspace name on the
 * invitee's notification, where it is worse than useless: the bell feed's
 * resolver deliberately refuses to render a hex id as a label, so the invite
 * showed no workspace name at all.
 *
 * The fallbacks are kept because they are what the working call site already
 * did: a hub whose `yp.hub.name` is genuinely NULL has no display name, and an
 * id is still better than an empty quote in an audit line. They are a last
 * resort, never the answer when a real name exists.
 *
 * @param {object} mfsHome    the target hub's `mfs_home` row (its `name` is
 *                            yp.hub.name). Anything falsy is simply skipped.
 * @param {...*}   fallbacks  tried in order when there is no display name.
 * @returns {*} the name to write, or null when even the fallbacks are empty.
 */
function resolveHubDisplayName(mfsHome, ...fallbacks) {
  const live = mfsHome && mfsHome.name;
  if (live) return live;
  for (const value of fallbacks) {
    if (value) return value;
  }
  return null;
}

module.exports = { resolveHubDisplayName };
