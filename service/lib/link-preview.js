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
 *   - Public share (no email / password gate)  → file name + sender; a file's
 *     own content card (image / video / document poster) as the image; a
 *     folder's first entry names. Anyone holding the link sees all of it on
 *     the share page anyway.
 *   - Secure share (email and/or password, locked) → a neutral "Secure link"
 *     card. NO file name, NO sender.
 *   - Revoked / expired / unknown token        → "Link unavailable".
 *   - Anything else (Internal links, the sign-in page) → a neutral Drumee
 *     card. Internal links stay fully private.
 * Fields never returned here: hub ids, node ids, emails, password state detail.
 */
const { toArray } = require("@drumee/server-essentials");
const { sqlString } = require("./sql-literal");
const { SIZE: FOLDER_CARD_SIZE } = require("./link-preview-folder-card");

/** Secure share tokens are 21–22 url-safe characters; accept a safe margin. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** Path segment of the short share link: `<endpoint>/s/<token>`. */
const SHORT_SEGMENT = "s";

/**
 * Query marker on an Internal link copied from an EXTERNAL workspace
 * (`…/-/?ext=1#/desk/wm/o/…`). Crawlers never get the fragment, so this is
 * the only way the page can tell them the link belongs to an external
 * workspace and draw its card in that workspace's pink. Mirrored in ui-team
 * libs/drumee-link-card.js (EXTERNAL_MARK).
 */
const EXTERNAL_MARK = { key: "ext", value: "1" };

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

/** Filetypes whose content card (a 460×260 poster) can stand as the preview image. */
const CARD_TYPES = /^(image|video|document)$/;
const CARD_SIZE = { width: 460, height: 260 };

/** How many names of a shared folder's contents a preview may list. */
const FOLDER_NAMES = 3;

/**
 * A Secure share token, resolved: its state, and for a PUBLIC share the share
 * row and the shared node. Gated, revoked, expired or unknown tokens never
 * reach the node. Never throws.
 * @param {*} yp
 * @param {string} token
 * @returns {Promise<{state:string, info?:Object, node?:Object}>}
 */
async function resolveShare(yp, token) {
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

  let node;
  const nid = info.node_id || info.nid;
  // A SQL error on the page server stops the whole page session (mariadb
  // _handleError → ERROR → index.js stops the session), so only reach into the
  // workspace DB when secure_share_info resolved it.
  if (nid && info.db_name) {
    try {
      node = toArray(
        await yp.await_proc("forward_proc", info.hub_id, "mfs_node_attr", `${sqlString(nid)}`)
      )[0];
    } catch (e) {
      node = undefined; /* name unknown → generic public card */
    }
  }
  return { state: STATE.public, info, node };
}

/**
 * Names of the first entries of a shared folder, for a PUBLIC share — the
 * same listing (and the same anonymous guest identity) the share page itself
 * shows to anyone holding the link (dmz.list_by_token).
 * @param {*} yp
 * @param {Object} info secure_share_info row
 * @param {Object} node the shared folder
 * @param {string} guestId sysconf guest_id
 * @returns {Promise<{items:string[], more:boolean}|null>}
 */
async function folderNames(yp, info, node, guestId) {
  const nid = node && (node.id || node.nid);
  if (!nid || !guestId || !info.db_name) return null;
  const params = JSON.stringify({ sort_by: "rank", order: "asc", page: 1, type: "all" });
  let rows;
  try {
    rows = toArray(
      await yp.await_proc(
        "forward_proc",
        info.hub_id,
        "mfs_show_node_by",
        `${sqlString(nid)}, ${sqlString(guestId)}, ${sqlString(params)}`
      )
    );
  } catch (e) {
    return null;
  }
  const names = [];
  for (const r of rows) {
    if (!r || !r.filename || /^\./.test(r.filename)) continue;
    const ext = r.ext && !FOLDER_TYPES.test(r.filetype || r.ftype || "") ? `.${r.ext}` : "";
    names.push(clean(`${r.filename}${ext}`));
  }
  if (!names.length) return null;
  return { items: names.slice(0, FOLDER_NAMES), more: names.length > FOLDER_NAMES };
}

/**
 * Public-safe facts about a Secure share token.
 * Never throws: any failure answers `unavailable`.
 * @param {*} yp
 * @param {string} token
 * @param {{guestId?:string}} [opt] guestId: list a public folder's first names
 * @returns {Promise<{state:string, filename?:string, filetype?:string, sender?:string,
 *          card?:boolean, items?:string[], more?:boolean}>}
 */
async function sharePreview(yp, token, opt = {}) {
  const { state, info, node } = await resolveShare(yp, token);
  if (state !== STATE.public) return { state };

  const res = { state: STATE.public, sender: clean(info.sender || info.name) };
  if (node) {
    res.filetype = clean(node.filetype);
    // The workspace root is named by the workspace, not by "/".
    res.filename = /^(root|hub)$/.test(node.filetype || "")
      ? clean(info.title)
      : clean(node.filename);
    if (CARD_TYPES.test(node.filetype || "")) res.card = true;
    if (FOLDER_TYPES.test(node.filetype || "") && opt.guestId) {
      const list = await folderNames(yp, info, node, opt.guestId);
      if (list) Object.assign(res, list);
    }
  }
  if (!res.filename) res.filename = clean(info.title);
  return res;
}

/**
 * The shared node of a PUBLIC share whose content card may be the preview
 * image (image, video, document), or null. Gated / revoked / expired / unknown
 * tokens and folders → null.
 * @param {*} yp
 * @param {string} token
 * @returns {Promise<Object|null>}
 */
async function shareCardNode(yp, token) {
  const { state, node } = await resolveShare(yp, token);
  if (state !== STATE.public || !node) return null;
  return CARD_TYPES.test(node.filetype || "") ? node : null;
}

/**
 * Folder holding the card images of the UI build (`<app>/link-preview/`),
 * next to the bundles the page loads, from the UI manifest.
 * @param {Object} manifest UI manifest.json
 * @returns {string|null} absolute path, e.g. /-/app/link-preview/
 */
function imageDir(manifest) {
  const main = manifest && manifest["main.js"];
  if (typeof main !== "string" || !/^\/[^\s"'<>]*$/.test(main)) return null;
  return `${main.replace(/[^/]*$/, "")}link-preview/`;
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
 * @returns {{title:string, description:string, image:string, card?:boolean}}
 */
function cardText(p) {
  const state = p && p.state;
  if (state === STATE.public) {
    const what = FOLDER_TYPES.test(p.filetype || "") ? "Folder" : "File";
    const title = p.filename || `Shared ${what.toLowerCase()}`;
    let description = p.sender
      ? `${what} shared by ${p.sender} via Drumee`
      : `${what} shared via Drumee`;
    // A public folder previews its first entries — anyone holding the link
    // sees them on the share page anyway.
    const listed = Array.isArray(p.items) && p.items.length > 0;
    if (listed) {
      description += ` · ${p.items.join(", ")}${p.more ? ", …" : ""}`;
    }
    // folderCard: the preview image draws the folder name and those entries
    // (link_preview.card, lib/link-preview-folder-card).
    return { title, description, image: "public", card: !!p.card, folderCard: listed };
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
    // An external workspace's Internal link: the same restricted card in the
    // external workspace's pink — the secure.png image is exactly that card.
    image: p && p.external ? "secure" : "neutral",
  };
}

/**
 * The external-workspace marker is on this page address.
 * @param {*} value  the `ext` query value
 * @returns {boolean}
 */
function isExternalMark(value) {
  return value === EXTERNAL_MARK.value;
}

/**
 * Inline script removing `ext=1` from the address before the app boots: the
 * marker is for link-preview crawlers only, so the app never sees it and a URL
 * copied later from the address bar never carries it to another item.
 * @returns {string}
 */
function stripMarkScript() {
  const mark = JSON.stringify(`${EXTERNAL_MARK.key}=${EXTERNAL_MARK.value}`);
  return `<script>(function(){try{var s=location.search.replace(/^\\?/,"").split("&").filter(function(p){return p!==${mark}}).join("&");history.replaceState(history.state,"",location.pathname+(s?"?"+s:"")+location.hash)}catch(e){}})()</script>`;
}

/**
 * Open Graph + Twitter card tags, already escaped.
 * @param {{title:string, description:string, image:string}} card
 * @param {{url?:string, imageBase?:string, cardUrl?:string}} where
 *        imageBase: absolute URL of the folder holding the card images
 *        (`<app>/link-preview/`); omitted → no image tags.
 *        cardUrl: absolute URL of link_preview.card for this token, used when
 *        the card is a public file (card.card).
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
  // A public file shows its own content card, a public folder its name and
  // first entries; everything else a card image of the build.
  const image = (card.card || card.folderCard) && where.cardUrl ? where.cardUrl : null;
  if (image) {
    const size = card.card ? CARD_SIZE : FOLDER_CARD_SIZE;
    tags.push(["og:image", image]);
    tags.push(["og:image:width", String(size.width)]);
    tags.push(["og:image:height", String(size.height)]);
  } else if (where.imageBase) {
    tags.push(["og:image", `${where.imageBase}${card.image}.png`]);
    tags.push(["og:image:width", "1200"]);
    tags.push(["og:image:height", "630"]);
  }
  const html = tags.map(([k, v]) => `<meta property="${esc(k)}" content="${esc(v)}">`);
  html.push(`<meta name="twitter:card" content="${image || where.imageBase ? "summary_large_image" : "summary"}">`);
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
  EXTERNAL_MARK,
  isExternalMark,
  stripMarkScript,
  isShareToken,
  shortShareLink,
  shortShareToken,
  shareHashPath,
  sharePreview,
  shareCardNode,
  imageDir,
  cardText,
  ogTags,
  rewriteScript,
  esc,
};
