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
const { existsSync } = require("fs");
const { join } = require("path");
const { readFileSync: readJsonSync } = require("jsonfile");
const { Mfs, Generator } = require("@drumee/server-core");
const { get_node_content } = require("@drumee/server-core/lib/utils/mfs");
const { Attr, Cache, Constants, sysEnv } = require("@drumee/server-essentials");
const { sharePreview, shareCardNode, imageDir } = require("./lib/link-preview");
const { CARD } = Constants;
const { ui_home } = sysEnv();

/**
 * Link previews for Drumee links — see service/lib/link-preview.js for what a
 * preview may reveal.
 *  - share: the facts Drumee's own chat draws its link card from.
 *  - card:  the preview image of a PUBLIC shared file — its own content card
 *           (the 460×260 poster the app shows), so a link pasted into
 *           Telegram / Zalo / Slack shows what was shared.
 */
class __link_preview extends Mfs {
  /**
   * @returns {Promise<void>}
   */
  async share() {
    const token = this.input.need(Attr.token);
    let guestId;
    try {
      guestId = Cache.getSysConf("guest_id");
    } catch (e) {
      guestId = undefined;
    }
    this.output.data(await sharePreview(this.yp, token, { guestId }));
  }

  /**
   * Content card of a public shared file. Anything else — a gated, revoked or
   * expired link, a folder, a file without a poster — gets the build's generic
   * public card image instead (a fixed address, never taken from the request).
   * @returns {Promise<void>}
   */
  async card() {
    const token = this.input.need(Attr.token);
    let node = null;
    try {
      node = await shareCardNode(this.yp, token);
    } catch (e) {
      node = null;
    }
    if (node) {
      try {
        const orig = get_node_content(node);
        const output = orig && existsSync(orig) ? get_node_content(node, CARD, "png") : null;
        if (output && !existsSync(output)) {
          // Same on-demand generator media.card uses; it swallows gm/ffmpeg
          // failures, so only an output that exists afterwards is served.
          const g = Generator[`create_${node.filetype}_${CARD}`];
          if (typeof g === "function") {
            try {
              g(output, orig, node);
            } catch (e) {
              this.debug(`[link_preview.card] no card for ${node.id}:`, e && e.message);
            }
          }
        }
        if (output && existsSync(output)) {
          await this.send_media(node, CARD);
          return;
        }
      } catch (e) {
        this.warn("[link_preview.card] falling back:", e && e.message);
      }
    }
    const dir = fallbackDir();
    if (dir) {
      this.output.redirect(`${dir}public.png`);
      return;
    }
    this.output.head({ "Cache-Control": "no-store" }, 204);
  }
}

/**
 * `<app>/link-preview/` of the UI build this server serves.
 * @returns {string|null}
 */
function fallbackDir() {
  try {
    const file = join(ui_home, "app", "manifest.json");
    if (!existsSync(file)) return null;
    return imageDir(readJsonSync(file));
  } catch (e) {
    return null;
  }
}

module.exports = __link_preview;
