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
const { Entity } = require('@drumee/server-core');
const { Attr } = require("@drumee/server-essentials");
const { sharePreview } = require("./lib/link-preview");

/**
 * Link cards for Drumee links pasted into Drumee's own chat.
 * Same public-safe facts the page server gives link-preview crawlers — see
 * service/lib/link-preview.js for what a preview may reveal.
 */
class __link_preview extends Entity {
  /**
   * @returns {Promise<void>}
   */
  async share() {
    const token = this.input.need(Attr.token);
    this.output.data(await sharePreview(this.yp, token));
  }
}

module.exports = __link_preview;
