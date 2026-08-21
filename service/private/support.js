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
const { Attr } = require("@drumee/server-essentials");
const { isEmpty } = require('lodash');

const Support       = require('../support');

/** yp.sys_conf key naming the account that answers "Contact Support". */
const SUPPORT_CONF_KEY = 'support_contact';

//########################################
class __private_support extends Support {

// ========================
// initialize
// ========================
  constructor(...args) {
    super(...args);
    this.list_feedback = this.list_feedback.bind(this);
    this.contact = this.contact.bind(this);
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
    const key = await this.yp.await_func('sys_conf_get', SUPPORT_CONF_KEY);
    if (isEmpty(key)) {
      this.output.data({ configured: 0 });
      return;
    }

    const drumate = await this.yp.await_proc('drumate_exists', key);
    if (isEmpty(drumate) || isEmpty(drumate.id)) {
      this.warn(`support.contact: ${SUPPORT_CONF_KEY}='${key}' names no known account`);
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

}

module.exports = __private_support;
