/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3.
 * https://www.gnu.org/licenses/agpl-3.0.html
 */

const { Attr } = require("@drumee/server-essentials");

/**
 * Stamp the author's display identity onto an outgoing chat payload (the
 * real-time broadcast AND the poster's own echo).
 *
 * `channel_list_messages` resolves firstname/lastname/fullname/email for every
 * listed row, but the posting paths only carried firstname + lastname — both
 * NULL for an account that has an email and no name (the typical secure-share
 * recipient). The chat item then fell through its whole fallback chain
 * (firstname/lastname → fullname → name → email) and rendered the raw 16-char
 * author id, with a "?" avatar. Keeping the same field set as the SP makes a
 * live message render exactly like the same message after a reload.
 *
 * No new exposure: these are the very fields `channel_list_messages` already
 * returns to the same audience (the hub's sockets) for the same message.
 *
 * `firstname`/`lastname` are written exactly as the call sites did before, so
 * existing consumers see no change; the rest is added only when non-empty.
 *
 * @param {object} user  the session user (`this.user`)
 * @param {object} data  outgoing message payload — mutated in place
 * @returns {object} the same `data`
 */
function stampAuthorIdentity(user, data) {
  if (!user || !data) return data;
  const profile = user.get("profile") || {};
  const firstname = user.attributes ? user.attributes.firstname : undefined;
  const lastname = profile.lastname;
  data.firstname = firstname;
  data.lastname = lastname;

  const name = [firstname, lastname].filter(Boolean).join(" ").trim();
  const fullname = name || user.get(Attr.fullname) || "";
  const email = user.get(Attr.email) || profile.email || "";
  if (fullname) data.fullname = fullname;
  if (email) data.email = email;
  // The chat item derives its avatar initials from `surname` and also uses it
  // as a firstname fallback — that is what `shareroom_contact_get` returns on
  // the list path (the name when there is one, else the email).
  const surname = name || fullname || email;
  if (surname) data.surname = surname;
  return data;
}

module.exports = { stampAuthorIdentity };
