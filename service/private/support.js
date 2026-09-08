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
const { Attr, toArray } = require("@drumee/server-essentials");
const { isEmpty } = require('lodash');

const Support       = require('../support');

const { stringify } = JSON;

/** Schema names are interpolated, never bound — this is what keeps that safe. */
const DB_NAME_RE = /^[A-Za-z0-9_]+$/;

/** yp.sys_conf key naming the account that answers "Contact Support". */
const SUPPORT_CONF_KEY = 'support_contact';

/** yp.sys_conf key overriding the greeting posted on the first open. */
const GREETING_CONF_KEY = 'support_greeting';

/**
 * Shipped greeting, used whenever `support_greeting` is unset. `{name}` is
 * replaced with the visitor's first name (dropped, along with the space
 * before it, when they have none).
 */
const DEFAULT_GREETING =
  'Hello {name} \ud83d\udc4b This is Drumee Support Center. If you have any ' +
  'problems while using the product, please message us here, the on-call CS ' +
  'will respond.';

/** Longest first name interpolated into the greeting. */
const NAME_MAX = 64;

/**
 * A value as a MySQL string literal, quotes included.
 *
 * `forward_proc` CONCATs its argument into a statement it PREPAREs, so what
 * goes in there is SQL, not a bound parameter \u2014 the escaping below is the only
 * thing standing between a value and the parser. Doubling `'` is not enough on
 * its own: a trailing backslash escapes the quote that follows it, so `x\''`
 * closes the literal and everything after it parses as SQL. Backslashes are
 * doubled first, for that reason.
 *
 * @param {String} value
 * @returns {String} the literal, e.g. `'it''s'`
 */
function sqlLiteral(value) {
  const s = `${value == null ? '' : value}`
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''");
  return `'${s}'`;
}

//########################################
class __private_support extends Support {

// ========================
// initialize
// ========================
  constructor(...args) {
    super(...args);
    this.list_feedback = this.list_feedback.bind(this);
    this.contact = this.contact.bind(this);
    this.greet = this.greet.bind(this);
  }

  /**
   *
   * @returns
   */
  list_feedback() {
    const page   = this.input.use(Attr.page);
    const column = this.input.use(Attr.sort_by) || Attr.date;
    const order  = this.input.use(Attr.order)   || Attr.desc;
    return this.db.call_proc('support_list_feedback', column, order, page, this.output.data);
  }

  /**
   * Resolve the account that answers "Contact Support" — the peer the client
   * opens a 1:1 conversation with.
   *
   * The account is named by the `support_contact` key in yp.sys_conf so a
   * self-hosted install can point it at its own admin (same mechanism as the
   * `support_domain` key read by notification_entity). The value may be either
   * an entity id or an email: `drumate_exists` accepts both.
   *
   * Answers `{configured: 0}` rather than an error whenever there is nothing
   * usable to talk to — no key set, or a key naming an account that has since
   * been deleted. The client falls back to the support mail link in that case,
   * so a missing configuration degrades instead of dead-ending.
   *
   * `is_self` tells the caller they ARE the support account: there is no
   * conversation to open with yourself, and the entry point hides.
   */
  async contact() {
    const drumate = await this._supportDrumate();
    if (isEmpty(drumate)) {
      this.output.data({ configured: 0 });
      return;
    }

    const firstname = drumate.firstname || '';
    const lastname = drumate.lastname || '';
    const display = [firstname, lastname].join(' ').trim() || drumate.email || drumate.id;

    this.output.data({
      configured: 1,
      is_self: drumate.id === this.uid ? 1 : 0,
      entity_id: drumate.id,
      firstname,
      lastname,
      display,
    });
  }

  /**
   * Post the support greeting into a support conversation that has none yet.
   *
   * A blank thread is the wrong first screen for someone asking for help, so
   * the conversation opens with support having already said hello. The client
   * calls this the first time it opens the support chat and then loads the
   * messages, which is why nothing is pushed over WS here.
   *
   * The text lives on the server, never on the client: the message is written
   * as support, and a client-supplied body would let anyone put words in the
   * support account's mouth.
   *
   * Idempotent, and cheap when it no-ops: the guard is a single indexed
   * lookup for anything support has already written to this user.
   */
  async greet() {
    // Read access is all this needs (the write lands in support's own DB,
    // not in the hub being browsed), and read access reaches guests. A guest
    // has no inbox to seed, so there is nothing to write on their behalf.
    if (this.session.isAnonymous()) {
      this.output.data({ posted: 0 });
      return;
    }

    const drumate = await this._supportDrumate();
    // Nothing configured, or the caller IS support — no thread to seed.
    if (isEmpty(drumate) || drumate.id === this.uid) {
      this.output.data({ posted: 0 });
      return;
    }

    // Has support already spoken to this user? Not "does a conversation
    // exist" — someone who wrote in before this feature shipped and got no
    // answer has a conversation and still needs greeting. And once a human
    // agent has replied, the canned line has no business appearing.
    if (await this._greeted(drumate.id)) {
      this.output.data({ posted: 0 });
      return;
    }

    const message = await this._greeting();
    if (isEmpty(message)) {
      this.output.data({ posted: 0 });
      return;
    }

    const message_id = await this.yp.await_func('uniqueId');
    // Written into SUPPORT's DB with the caller as peer: p2p messages are
    // single-write, stored once in the author's DB. The proc handles the
    // cross-DB p2p_time so the caller's inbox lists the conversation.
    const input = {
      author_id: drumate.id,
      uid: drumate.id,
      peer_id: this.uid,
      message_id,
    };

    try {
      await this.yp.await_proc(
        'forward_proc',
        drumate.id,
        'p2p_post_message',
        `${sqlLiteral(stringify(input))},${sqlLiteral(message)}`,
      );
    } catch (e) {
      this.warn('support.greet: could not post the greeting:', e && e.message);
      this.output.data({ posted: 0 });
      return;
    }

    this.output.data({ posted: 1, message_id, message });
  }

  /**
   * Whether the support account has ever posted to the calling user.
   *
   * P2P messages are single-write, stored once in their AUTHOR's DB, so
   * anything support said lives in support's DB — not the caller's. Hence the
   * cross-DB read; the caller's own tables cannot answer this.
   *
   * Errs towards "yes" when the lookup fails: a greeting that is silently
   * skipped is a much smaller problem than one posted on every open.
   *
   * @param {String} support_id
   * @returns {Promise<Boolean>}
   */
  async _greeted(support_id) {
    try {
      const entity = await this.yp.await_query(
        'SELECT db_name FROM entity WHERE id = ? LIMIT 1',
        `${support_id}`,
      );
      const row = toArray(entity)[0];
      const db = row && row.db_name;
      // Interpolated because a schema name cannot be a bound parameter; the
      // pattern is what keeps that safe, and the value comes from yp.entity
      // rather than from the request.
      if (!db || !DB_NAME_RE.test(db)) return true;

      const said = await this.yp.await_query(
        `SELECT message_id FROM \`${db}\`.p2p_channel
          WHERE peer_id = ? AND author_id = ? LIMIT 1`,
        `${this.uid}`,
        `${support_id}`,
      );
      return !isEmpty(said);
    } catch (e) {
      this.warn('support.greet: could not check for an earlier greeting:', e && e.message);
      return true;
    }
  }

  /**
   * The account named by `support_contact`, or null when the key is unset or
   * names an account that no longer exists. `drumate_exists` accepts either an
   * entity id or an email, so the key may be written as either.
   */
  async _supportDrumate() {
    const key = await this.yp.await_func('sys_conf_get', SUPPORT_CONF_KEY);
    if (isEmpty(key)) return null;

    const drumate = await this.yp.await_proc('drumate_exists', key);
    if (isEmpty(drumate) || isEmpty(drumate.id)) {
      this.warn(`support: ${SUPPORT_CONF_KEY}='${key}' names no known account`);
      return null;
    }
    return drumate;
  }

  /**
   * Greeting text for the calling user. An install can replace it wholesale
   * through the `support_greeting` key; `{name}` in either the configured or
   * the shipped text becomes the caller's first name, and collapses with the
   * space in front of it when they have none.
   */
  async _greeting() {
    let text = await this.yp.await_func('sys_conf_get', GREETING_CONF_KEY);
    if (isEmpty(text)) text = DEFAULT_GREETING;

    // The one part of this message the caller controls. sqlLiteral() is what
    // makes it safe to interpolate; the rest is hygiene — control characters
    // have no business in a greeting, and a 500-character "first name" would
    // bury the sentence it sits in.
    const name = `${this.user.get(Attr.firstname) || ''}`
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .trim()
      .slice(0, NAME_MAX)
      .trim();
    return text.replace(/ ?\{name\}/g, name ? ` ${name}` : '').trim();
  }

}

module.exports = __private_support;
