/**
 * @license
 * Copyright 2024 Thidima SA. All Rights Reserved.
 * Licensed under the GNU AFFERO GENERAL PUBLIC LICENSE, Version 3 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.gnu.org/licenses/agpl-3.0.html
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

/**
 * Preview image (1200×630) of a PUBLIC shared folder: the build's public.png
 * card (ui-team assets/link-preview, drawn from the share e-mail) holding the
 * folder's real name and its first entries laid out like the desk's list view
 * (window/skeleton/content/row: Name · Size · Type; a folder's size is "--",
 * its type "folder"). The card's height follows the number of rows so it stays
 * centred. A file shows the desk's own icon (lib/link-preview-file-icons) or,
 * for a picture / video, its thumbnail (`thumbData`, read by the caller).
 * Pure: SVG text out, the caller rasterises it (sharp).
 */
const { iconSvg } = require("./link-preview-file-icons");

// The new Drumee logo (ui-team src/drumee/assets/drumee-logo.svg, 120.723×24),
// drawn white like the build's cards: [evenodd, path].
const LOGO_PATHS = [
  [true, "M37.8475 24C39.72 24 41.4143 23.2597 42.228 21.9719C42.2944 21.8667 42.4931 21.9122 42.4931 22.0365V23.3981C42.4931 23.5648 42.6286 23.7 42.7957 23.7H45.3044C45.4715 23.7 45.607 23.5648 45.607 23.3981V5.21191C45.607 5.04521 45.4715 4.91003 45.3044 4.91003H42.7957C42.6286 4.91003 42.4931 5.04521 42.4931 5.21191V11.5014C42.4931 11.6434 42.3056 11.7143 42.2012 11.6177C41.1897 10.6818 39.2362 9.94579 37.6717 9.94578C34.131 9.94578 31.5445 12.8269 31.5445 16.9857C31.5445 21.2197 34.2063 24 37.8475 24ZM38.6009 20.9942C36.7426 20.9942 35.4619 19.3657 35.4619 17.0358C35.4619 14.7309 36.7426 13.1275 38.6009 13.1275C40.4591 13.1275 41.7398 14.7059 41.7398 16.9857C41.7397 19.3407 40.4591 20.9942 38.6009 20.9942Z"],
  [false, "M74.2408 23.7C74.4079 23.7 74.5433 23.5649 74.5433 23.3982V15.683C74.5433 14.2299 75.6482 13.2278 77.2303 13.2278C78.3352 13.2278 79.0383 13.9793 79.0383 15.1318V23.3982C79.0383 23.5649 79.1738 23.7 79.3409 23.7H82.6029C82.77 23.7 82.9055 23.5649 82.9055 23.3982V15.683C82.9055 14.2299 84.0104 13.2278 85.5924 13.2278C86.6973 13.2278 87.4004 13.9793 87.4004 15.1318V23.3982C87.4004 23.5649 87.5359 23.7 87.703 23.7H90.9651C91.1322 23.7 91.2677 23.5649 91.2677 23.3982V14.9314C91.2677 11.9 89.5099 9.94579 86.7476 9.94578C84.6964 9.94578 83.1662 11.3037 82.4368 12.5134C82.3892 12.5922 82.271 12.5895 82.2273 12.5085C81.4764 11.1147 80.1374 9.94579 78.3854 9.94578C76.4567 9.94578 74.7483 10.6371 73.9412 11.6923C73.8949 11.7528 73.79 11.7214 73.79 11.6453V10.7236C73.79 10.5569 73.6545 10.4218 73.4874 10.4218H70.9787C70.8116 10.4218 70.6762 10.5569 70.6761 10.7236V23.3982C70.6762 23.5649 70.8116 23.7 70.9787 23.7H74.2408Z"],
  [true, "M99.5674 24C102.669 24 104.941 22.5769 105.791 19.8396C105.849 19.6518 105.704 19.466 105.507 19.466H102.36C102.236 19.466 102.126 19.5427 102.07 19.6535C101.65 20.49 100.765 20.9692 99.6177 20.9692C97.8535 20.9692 96.5914 19.8004 96.2746 18.0679C96.2622 17.9997 96.3154 17.9377 96.3849 17.9377H105.643C105.81 17.9377 105.946 17.8026 105.946 17.6359V17.0859C105.87 12.7267 103.184 9.9458 99.3164 9.94578C95.2734 9.94578 92.587 12.8771 92.587 17.111C92.5871 21.2698 95.3738 24 99.5674 24ZM96.5582 15.4825C96.4816 15.4825 96.427 15.4081 96.4526 15.336C96.9306 13.9931 97.9831 13.1526 99.3164 13.1526C100.629 13.1526 101.565 13.9505 101.965 15.342C101.986 15.4129 101.931 15.4825 101.857 15.4825H96.5582Z"],
  [true, "M114.345 24C117.446 24 119.719 22.5769 120.568 19.8396C120.626 19.6518 120.482 19.466 120.284 19.466H117.137C117.013 19.466 116.903 19.5427 116.847 19.6535C116.427 20.49 115.542 20.9692 114.395 20.9692C112.631 20.9692 111.368 19.8004 111.052 18.0679C111.039 17.9998 111.092 17.9377 111.162 17.9377H120.42C120.587 17.9377 120.723 17.8026 120.723 17.6359V17.0859C120.648 12.7267 117.961 9.94578 114.093 9.94578C110.05 9.94578 107.364 12.8771 107.364 17.111C107.364 21.2698 110.151 24 114.345 24ZM111.335 15.4825C111.259 15.4825 111.204 15.4081 111.23 15.336C111.708 13.9931 112.76 13.1526 114.093 13.1526C115.406 13.1526 116.342 13.9505 116.742 15.342C116.763 15.4129 116.708 15.4825 116.634 15.4825H111.335Z"],
  [false, "M50.4827 23.7C50.6498 23.7 50.7853 23.5649 50.7853 23.3982V17.562C50.7853 15.2821 52.3924 13.9292 55.1044 13.9292H55.3795C55.5466 13.9292 55.682 13.7941 55.682 13.6274V10.5232C55.682 10.3565 55.5466 10.2214 55.3795 10.2213H55.1044C53.1093 10.2213 51.2399 10.798 50.2802 12.3482C50.2159 12.452 50.032 12.4088 50.0319 12.2867V10.7236C50.0319 10.5569 49.8964 10.4218 49.7293 10.4218H47.2206C47.0536 10.4218 46.9181 10.5569 46.918 10.7236V23.3982C46.9181 23.5649 47.0536 23.7 47.2206 23.7H50.4827Z"],
  [false, "M61.9423 23.9998C63.6268 23.9998 65.1702 23.3498 65.9625 22.2445C66.0321 22.1473 66.2107 22.1945 66.2107 22.3139V23.398C66.2107 23.5647 66.3461 23.6998 66.5131 23.6998H69.022C69.189 23.6998 69.3244 23.5647 69.3244 23.398V10.7235C69.3244 10.5568 69.189 10.4217 69.022 10.4216H65.7599C65.5928 10.4216 65.4573 10.5568 65.4573 10.7235V18.3886C65.4573 19.8166 64.5287 20.8187 62.9718 20.8187C61.666 20.8187 60.9127 20.0671 60.9127 18.9648V10.7235C60.9127 10.5568 60.7772 10.4216 60.6101 10.4216H57.348C57.1809 10.4216 57.0455 10.5568 57.0455 10.7235V19.1652C57.0455 22.1966 58.8786 23.9998 61.9423 23.9998Z"],
  [false, "M6.50586 0C8.67653 0 9.86132 0.975908 11.4775 2.52832C11.4775 2.52832 12.0731 3.07601 13.0479 2.70801C15.2622 2.05083 18.731 1.03961 21.0381 1.32812C23.9031 1.68644 24.5925 3.13789 25.0869 4.00488C25.5233 4.79112 26.0433 5.89665 26.2354 7.82422C27.67 8.98586 28.6269 10.84 28.627 12.7881C28.6269 15.3748 27.3001 17.5057 25.1084 18.4492C24.6166 21.3871 21.9036 23.7109 18.8936 23.7109C17.4802 23.7109 16.1662 23.1708 15.1328 22.3438C14.0995 23.1708 12.8117 23.7109 11.3984 23.7109C8.83945 23.7109 6.81128 22.0375 5.91016 19.748C2.69757 19.5141 1.6238e-06 16.8288 0 13.4805C1.4313e-05 11.6562 0.50332 10.3628 1.70801 9.20605C1.53435 7.91027 1.50198 5.20433 1.76758 4.18848C2.10504 1.8194 4.09809 8.20064e-05 6.50586 0ZM15.1006 6.51758C14.0226 6.51758 13.1484 7.47124 13.1484 8.5625V11.8291C13.1485 12.9204 14.0226 13.873 15.1006 13.873C16.1785 13.873 17.0527 12.9203 17.0527 11.8291V8.5625C17.0527 7.47127 16.1785 6.51763 15.1006 6.51758ZM20.4424 6.58594C19.3644 6.58594 18.4902 7.47124 18.4902 8.5625V11.8291C18.4902 12.9204 19.3644 13.873 20.4424 13.873C21.5201 13.8728 22.3935 12.9202 22.3936 11.8291V8.5625C22.3936 7.47138 21.5201 6.58617 20.4424 6.58594Z"],
];

const SIZE = { width: 1200, height: 630 };
const PURPLE = "#433cc5";
const PINK = "#ffa8dc";
const INK = "#0b0a21";
const TEXT = "#363246";
const MUTED = "#6e6b7b";
const LINE = "rgba(71,69,84,0.12)";
const FONT = "Manrope, Lato, 'DejaVu Sans', 'Droid Sans Fallback', sans-serif";
const FOLDER_PATH =
  "M33.5743 1.5H15C8.37258 1.5 3 6.87258 3 13.5V69C3 75.6274 8.37258 81 15 81H90C96.6274 81 102 75.6274 102 69L102 28.2C102 21.5726 96.6274 16.2 90 16.2H58.8349C55.8072 16.2 52.8913 15.0555 50.672 12.9959L41.7372 4.70411C39.5179 2.64453 36.6021 1.5 33.5743 1.5Z";
// Box of a row's icon / thumbnail.
const ICON = 36;
// Widths in "narrow character" units; a wide (CJK, emoji…) one counts 2.
const TITLE_UNITS = 40;
const NAME_UNITS = 38;
const TYPE_UNITS = 9;
const ROWS = 4;

// Card geometry (px of the 1200×630 image).
const CARD = { x: 60, width: 1080, pad: 44, padBottom: 28 };
const LEFT = CARD.x + CARD.pad; // 104
const RIGHT = CARD.x + CARD.width - CARD.pad; // 1096
const TITLE_H = 56;
const GAP = 16;
const HEAD_H = 44;
const ROW_H = 60;
// Names line up with the title text (the Name header with the icons, on the
// left edge); Size and Type end on the right edge of the three dots (both
// right-aligned).
const COL = { name: LEFT + 64, size: RIGHT - 150, type: RIGHT };

/**
 * XML text escape; drops characters XML 1.0 forbids (an SVG with one fails).
 * @param {*} v
 * @returns {string}
 */
function xml(v) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {string} ch one code point
 * @returns {number} 2 for a wide character, else 1
 */
function width(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x1100 && /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch)
    ? 2
    : 1;
}

/**
 * Cut `text` to `max` units, ending with "…" when cut (SVG text never wraps or
 * clips by itself).
 * @param {*} text
 * @param {number} max
 * @returns {string}
 */
function fit(text, max) {
  const chars = Array.from(String(text == null ? "" : text).replace(/\s+/g, " ").trim());
  let used = 0;
  for (let i = 0; i < chars.length; i++) {
    used += width(chars[i]);
    if (used > max) return `${chars.slice(0, i).join("").replace(/\s+$/, "")}…`;
  }
  return chars.join("");
}

/**
 * Size as the desk's list shows it (ui-team `filesize` defaults: base 1000,
 * up to 2 decimals): 0 B, 512 B, 1.23 kB, 98.77 MB, 5 GB.
 * @param {*} bytes
 * @returns {string}
 */
function humanSize(bytes) {
  let n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let u = 0;
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000;
    u++;
  }
  return `${u ? Number(n.toFixed(2)) : Math.round(n)} ${units[u]}`;
}

/**
 * @param {{name:string, ext?:string, size?:number, folder?:boolean}} e
 * @param {number} top
 * @param {boolean} last no divider under the last row
 * @returns {string}
 */
function row(e, top, last) {
  const mid = top + ROW_H / 2;
  let icon;
  if (e.folder) {
    // A folder of an external (shared) workspace is pink on the desk.
    icon = `<g transform="translate(${LEFT} ${mid - 13}) scale(0.305)" fill="${PINK}"><path d="${FOLDER_PATH}"/></g>`;
  } else if (typeof e.thumbData === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(e.thumbData)) {
    // The file's own thumbnail, cropped square, like the desk's list row.
    const t = ICON - 4;
    const x = LEFT;
    const yy = mid - t / 2;
    icon =
      `<clipPath id="t${top}"><rect x="${x}" y="${yy}" width="${t}" height="${t}" rx="5"/></clipPath>` +
      `<image x="${x}" y="${yy}" width="${t}" height="${t}" preserveAspectRatio="xMidYMid slice" clip-path="url(#t${top})" href="${e.thumbData}"/>` +
      (e.video ? iconSvg("video", x + t / 2 - 8, mid - 8, 16) : "");
  } else {
    icon = iconSvg(e.icon, LEFT, mid - ICON / 2, ICON);
  }
  const size = e.folder ? "--" : humanSize(e.size);
  const type = e.folder ? "folder" : fit(String(e.ext || "").toLowerCase(), TYPE_UNITS);
  const base = mid + 9;
  return (
    icon +
    `<text x="${COL.name}" y="${base}" font-size="26" font-weight="600" fill="${TEXT}">${xml(fit(e.name, NAME_UNITS))}</text>` +
    (size ? `<text x="${COL.size}" y="${base}" font-size="24" fill="${MUTED}" text-anchor="end">${xml(size)}</text>` : "") +
    (type ? `<text x="${COL.type}" y="${base}" font-size="24" fill="${MUTED}" text-anchor="end">${xml(type)}</text>` : "") +
    (last ? "" : `<rect x="${LEFT}" y="${top + ROW_H - 2}" width="${RIGHT - LEFT}" height="2" fill="${LINE}"/>`)
  );
}

/**
 * @param {{title:string, single?:boolean, entries:{name:string, ext?:string, size?:number, folder?:boolean}[]}} folder
 *        single: a shared file listed as its only row (its icon by the title)
 * @returns {string|null} SVG, or null when there is nothing real to show
 */
function folderCardSvg(folder) {
  const entries = (folder && Array.isArray(folder.entries) ? folder.entries : [])
    .filter((e) => e && fit(e.name, NAME_UNITS))
    .slice(0, ROWS);
  if (!entries.length) return null;
  const title = fit(folder.title, TITLE_UNITS);
  const single = !!folder.single && !entries[0].folder;

  // The card's height follows the rows; it is centred under the header.
  const height = CARD.pad + TITLE_H + GAP + HEAD_H + entries.length * ROW_H + CARD.padBottom;
  const y = Math.round(150 + (SIZE.height - 150 - height) / 2);
  const titleMid = y + CARD.pad + TITLE_H / 2;
  const headTop = y + CARD.pad + TITLE_H + GAP;
  const rowsTop = headTop + HEAD_H;

  const logoScale = 300 / 120.723;
  const logo = LOGO_PATHS.map(
    ([eo, d]) => `<path${eo ? ' fill-rule="evenodd" clip-rule="evenodd"' : ""} d="${d}"/>`
  ).join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE.width}" height="${SIZE.height}" viewBox="0 0 ${SIZE.width} ${SIZE.height}">` +
    `<rect width="${SIZE.width}" height="${SIZE.height}" fill="#ffffff"/>` +
    `<rect width="${SIZE.width}" height="150" fill="${PURPLE}"/>` +
    `<g fill="#ffffff" transform="translate(450 ${(75 - (24 * logoScale) / 2).toFixed(2)}) scale(${logoScale.toFixed(5)})">${logo}</g>` +
    `<rect x="${CARD.x + 1}" y="${y + 1}" width="${CARD.width - 2}" height="${height - 2}" rx="15" fill="#f2f2f7" stroke="${LINE}" stroke-width="2"/>` +
    // A single shared file: its own icon by its name; a folder: the pink folder.
    (single
      ? iconSvg(entries[0].icon, LEFT, titleMid - 24, 48)
      : `<g transform="translate(${LEFT} ${titleMid - 19}) scale(0.44)" fill="${PINK}"><path d="${FOLDER_PATH}"/></g>`) +
    `<g fill="rgba(20,17,35,0.4)"><circle cx="${RIGHT - 51}" cy="${titleMid}" r="7"/><circle cx="${RIGHT - 29}" cy="${titleMid}" r="7"/><circle cx="${RIGHT - 7}" cy="${titleMid}" r="7"/></g>` +
    `<g font-family="${xml(FONT)}">` +
    (title ? `<text x="${COL.name}" y="${titleMid + 11}" font-size="32" font-weight="700" fill="${INK}">${xml(title)}</text>` : "") +
    `<g font-size="20" font-weight="600" fill="${MUTED}">` +
    `<text x="${LEFT}" y="${headTop + 28}">Name</text>` +
    `<text x="${COL.size}" y="${headTop + 28}" text-anchor="end">Size</text>` +
    `<text x="${COL.type}" y="${headTop + 28}" text-anchor="end">Type</text>` +
    `</g>` +
    `<rect x="${LEFT}" y="${headTop + HEAD_H - 2}" width="${RIGHT - LEFT}" height="2" fill="${LINE}"/>` +
    entries.map((e, i) => row(e, rowsTop + i * ROW_H, i === entries.length - 1)).join("") +
    `</g>` +
    `</svg>`
  );
}

module.exports = { SIZE, ROWS, folderCardSvg, fit, xml, humanSize };
