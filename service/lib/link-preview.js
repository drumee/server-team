/**
 * Link previews for Drumee links pasted into chat apps (Telegram, Zalo, Slack,
 * Messenger, WhatsApp, Discord, …) and into Drumee's own chat.
 *
 * ── Why a short share path exists ───────────────────────────────────────────
 *
 * Every Drumee link used to carry its identity after `#`:
 *   https://share.<domain>/-/#/dmz/share/<token>
 * Link-preview crawlers never send the fragment, so every link looked the same
 * to them ("Drumee", no description, no image). The External link (Secure
 * share) is now handed out as
 *   https://share.<domain>/-/s/<token>
 * — 10 characters SHORTER — which the crawler can read. The page server answers
 * that path with the normal app page plus Open Graph tags, and a one-line
 * script rewrites the address to the old `#/dmz/share/<token>` form before any
 * app bundle loads, so the app opens the share exactly as it always did. Links
 * already in circulation (`#/dmz/share/…`) keep working untouched.
 *
 * ── What a preview may reveal ───────────────────────────────────────────────
 *
 * A crawler is anonymous, and so is everyone the link is forwarded to:
 *   - Public share (no email / password gate)  → file name + sender. Anyone
 *     holding the link can open it anyway.
 *   - Secure share (email and/or password, locked) → a neutral "Secure link"
 *     card. NO file name, NO sender.
 *   - Revoked / expired / unknown token        → "Link unavailable".
 *   - Anything else (Internal links, the sign-in page) → a neutral Drumee
 *     card. Internal links stay fully private.
 * Fields never returned here: hub ids, node ids, emails, password state detail.
 */
const { toArray } = require("@drumee/server-essentials");
const { sqlString } = require("./sql-literal");

/** Secure share tokens are 21–22 url-safe characters; accept a safe margin. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** Path segment of the short share link: `<endpoint>/s/<token>`. */
const SHORT_SEGMENT = "s";

const STATE = {
  public: "public",
  secure: "secure",
  unavailable: "unavailable",
};

/**
 * @param {*} token
 * @returns {boolean}
 */
function isShareToken(token) {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/**
 * Short External link for a token.
 * @param {string} base  homepath of the share host, e.g. https://share.x/-/
 * @param {string} token
 * @returns {string}
 */
function shortShareLink(base, token) {
  const root = String(base).replace(/\/*$/, "/");
  // A token the page server would not recognise keeps the historic form, so a
  // link is never handed out that could fail to open.
  if (!isShareToken(token)) return `${root}#/dmz/share/${token}`;
  return `${root}${SHORT_SEGMENT}/${token}`;
}

/**
 * Token carried by a short share path, or null.
 * @param {string} pathname      request path, e.g. /-/preview/s/<token>
 * @param {string} endpointPath  this endpoint's mount, e.g. /-/preview/
 * @returns {string|null}
 */
function shortShareToken(pathname, endpointPath) {
  if (typeof pathname !== "string" || typeof endpointPath !== "string") return null;
  const prefix = `${endpointPath.replace(/\/+$/, "")}/${SHORT_SEGMENT}/`;
  if (!pathname.startsWith(prefix)) return null;
  const token = pathname.slice(prefix.length).replace(/\/+$/, "");
  return isShareToken(token) ? token : null;
}

/**
 * The address the app expects for a share token (the historic hash form).
 * @param {string} endpointPath
 * @param {string} token
 * @returns {string}
 */
function shareHashPath(endpointPath, token) {
  return `${endpointPath.replace(/\/+$/, "")}/#/dmz/share/${token}`;
}

/**
 * Public-safe facts about a Secure share token.
 * Never throws: any failure answers `unavailable`.
 * @param {*} yp
 * @param {string} token
 * @returns {Promise<{state:string, filename?:string, filetype?:string, sender?:string}>}
 */
async function sharePreview(yp, token) {
  if (!isShareToken(token)) return { state: STATE.unavailable };
  let info;
  try {
    info = toArray(await yp.await_proc("secure_share_info", token))[0];
  } catch (e) {
    return { state: STATE.unavailable };
  }
  if (!info || info.failed || !info.hub_id) return { state: STATE.unavailable };
  if (info.validity !== "TICKET_OK") return { state: STATE.unavailable };
  const gated =
    Number(info.require_password) > 0 ||
    Number(info.require_email) > 0 ||
    Number(info.is_locked) > 0 ||
    !!info.recipient_email ||
    !!info.domain_restriction;
  if (gated) return { state: STATE.secure };

  const res = { state: STATE.public, sender: clean(info.sender || info.name) };
  const nid = info.node_id || info.nid;
  // A SQL error on the page server stops the whole page session (mariadb
  // _handleError → ERROR → index.js stops the session), so only reach into the
  // workspace DB when secure_share_info resolved it.
  if (nid && info.db_name) {
    try {
      const node = toArray(
        await yp.await_proc("forward_proc", info.hub_id, "mfs_node_attr", `${sqlString(nid)}`)
      )[0];
      if (node) {
        res.filetype = clean(node.filetype);
        // The workspace root is named by the workspace, not by "/".
        res.filename = /^(root|hub)$/.test(node.filetype || "")
          ? clean(info.title)
          : clean(node.filename);
      }
    } catch (e) {
      /* name unknown → generic public card */
    }
  }
  if (!res.filename) res.filename = clean(info.title);
  return res;
}

/**
 * @param {*} v
 * @returns {string}
 */
function clean(v) {
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * HTML-attribute escape. Template interpolation (lodash `<%= %>`) is raw, and
 * file names are user-chosen.
 * @param {*} v
 * @returns {string}
 */
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FOLDER_TYPES = /^(folder|root|hub)$/;

/**
 * Card text for a preview state.
 * @param {{state?:string, filename?:string, filetype?:string, sender?:string}} p
 *        `undefined` / no state → the neutral Drumee card.
 * @returns {{title:string, description:string, image:string}}
 */
function cardText(p) {
  const state = p && p.state;
  if (state === STATE.public) {
    const what = FOLDER_TYPES.test(p.filetype || "") ? "Folder" : "File";
    const title = p.filename || `Shared ${what.toLowerCase()}`;
    const description = p.sender
      ? `${what} shared by ${p.sender} via Drumee`
      : `${what} shared via Drumee`;
    return { title, description, image: "public" };
  }
  if (state === STATE.secure) {
    return {
      title: "Secure link · Drumee",
      description: "A protected file was shared with you on Drumee. Verification is required to open it.",
      image: "secure",
    };
  }
  if (state === STATE.unavailable) {
    return {
      title: "Link unavailable · Drumee",
      description: "This shared link has expired or is no longer available.",
      image: "neutral",
    };
  }
  return {
    title: "Drumee",
    description: "Secure workspace for files, chat and meetings. Sign in to open this link.",
    image: "neutral",
  };
}

/**
 * Open Graph + Twitter card tags, already escaped.
 * @param {{title:string, description:string, image:string}} card
 * @param {{url?:string, imageBase?:string}} where
 *        imageBase: absolute URL of the folder holding the card images
 *        (`<app>/link-preview/`); omitted → no image tags.
 * @returns {string}
 */
function ogTags(card, where = {}) {
  const tags = [
    ["og:site_name", "Drumee"],
    ["og:type", "website"],
    ["og:title", card.title],
    ["og:description", card.description],
  ];
  if (where.url) tags.push(["og:url", where.url]);
  if (where.imageBase) {
    tags.push(["og:image", `${where.imageBase}${card.image}.png`]);
    tags.push(["og:image:width", "1200"]);
    tags.push(["og:image:height", "630"]);
  }
  const html = tags.map(([k, v]) => `<meta property="${esc(k)}" content="${esc(v)}">`);
  html.push(`<meta name="twitter:card" content="${where.imageBase ? "summary_large_image" : "summary"}">`);
  html.push(`<meta name="twitter:title" content="${esc(card.title)}">`);
  html.push(`<meta name="twitter:description" content="${esc(card.description)}">`);
  return html.join("\n    ");
}

/**
 * Inline script that turns `/…/s/<token>` into the historic hash address
 * before the app boots. Token is validated by TOKEN_RE (url-safe chars only);
 * JSON-encoded and `<` escaped anyway.
 * @param {string} endpointPath
 * @param {string} token
 * @returns {string}
 */
function rewriteScript(endpointPath, token) {
  if (!isShareToken(token)) return "";
  const js = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
  const path = js(`${endpointPath.replace(/\/+$/, "")}/`);
  const hash = js(`#/dmz/share/${token}`);
  // path + (any query) + hash — the query must stay BEFORE the fragment.
  return `<script>(function(){var u=${path}+location.search+${hash};try{history.replaceState(history.state,"",u)}catch(e){location.replace(u)}})()</script>`;
}

module.exports = {
  STATE,
  SHORT_SEGMENT,
  isShareToken,
  shortShareLink,
  shortShareToken,
  shareHashPath,
  sharePreview,
  cardText,
  ogTags,
  rewriteScript,
  esc,
};
