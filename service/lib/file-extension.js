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
 * The extension of a stored file becomes part of its path on disk
 * (`orig.<ext>`), and that path is handed to the thumbnail / conversion tools.
 * So only plain extensions are kept: letters and digits, optionally joined by
 * single dots, dashes or underscores (`pdf`, `tar.bz2`, `drumee.html`,
 * `mkvtimestamp_v2`), at most 16 characters (the width of yp.filecap.extension).
 * Anything else is dropped and the file is stored without an extension.
 *
 * The case is kept as given: each caller already decides whether to lowercase.
 */
const EXTENSION_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;
const EXTENSION_MAX = 16;

/**
 * @param {*} ext - extension without the leading dot
 * @returns {string} ext when it is a plain extension, otherwise ""
 */
function safeExtension(ext) {
  if (ext == null) return "";
  ext = String(ext);
  if (!ext || ext.length > EXTENSION_MAX || !EXTENSION_RE.test(ext)) return "";
  return ext;
}

module.exports = { safeExtension, EXTENSION_RE, EXTENSION_MAX };
