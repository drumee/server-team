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
 * MySQL string literals for `forward_proc` argument lists.
 *
 * `forward_proc` CONCATs its argument into a statement it PREPAREs, so what
 * goes in there is SQL, not a bound parameter — the escaping below is the only
 * thing standing between a value and the parser. Doubling `'` is not enough on
 * its own: a trailing backslash escapes the quote that follows it, so `x\''`
 * closes the literal and everything after it parses as SQL. Backslashes are
 * doubled first, for that reason.
 */
function escapeSql(text) {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/**
 * A value as a string literal, null / undefined as the empty string.
 * @param {*} value
 * @returns {String} the literal, e.g. `'it''s'`
 */
function sqlLiteral(value) {
  return `'${escapeSql(`${value == null ? '' : value}`)}'`;
}

/**
 * A value as a string literal, stringified exactly like a template literal
 * (`'${value}'`) — so for any value without a quote or a backslash the text is
 * the same as the hand-written `'${value}'` it replaces.
 * @param {*} value
 * @returns {String} the literal
 */
function sqlString(value) {
  return `'${escapeSql(`${value}`)}'`;
}

module.exports = { sqlLiteral, sqlString };
