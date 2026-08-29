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
const { Attr, Constants, uniqueId } = require("@drumee/server-essentials");
const { dom_owner } = Constants;
const { isEmpty } = require("lodash");
const { Mfs } = require("@drumee/server-core");
const { stringify } = JSON;

//########################################
class __seo_admin extends Mfs {
  constructor(...args) {
    super(...args);
    this.admin_add = this.admin_add.bind(this);
  }

  async admin_add() {
    let pw = this.input.need(Attr.password);
    let firstname = this.input.need(Attr.firstname);
    let lastname = this.input.need(Attr.lastname);
    let ident = this.input.need(Attr.ident);
    let email = this.input.need(Attr.email).trim();
    ident = ident.toLowerCase();
    let domain = await this.yp.await_proc("domain_exists", 1); //NEEED TO CHANGE
    let profile = {};
    let newuser;

    let chk = await this.yp.await_proc(
      "get_user_in_domain",
      ident,
      domain.name
    );
    if (chk.exists == 1) return this.output.status("IDENT_NOT_AVAILABLE");
    chk = await this.yp.await_proc("email_exists", email);
    if (!isEmpty(chk)) return this.output.status("EMAIL_NOT_AVAILABLE");

    profile.firstname = firstname || "";
    profile.lastname = lastname || "";
    profile.email = email || "";
    profile.ident = ident;
    profile.username = ident;
    profile.otp = 0;
    profile.email_verified = "yes";
    profile.connected = "1";
    profile.sharebox = uniqueId();
    profile.domain = domain.name;
    // Product default is English — do not stamp the creator's browser
    // language onto the new account.
    profile.lang = 'en';
    profile.privilege = dom_owner;

    const rows = await this.yp.await_proc(
      "drumate_create",
      pw,
      stringify(profile)
    );
    if (isEmpty(rows))
      return this.exception.server("Failed to create account -- Factory Empty");

    for (let r of rows) {
      if (r && r.failed)
        return this.exception.server(
          "Failed to create account -- Factory Failed"
        );
    }
    for (let r of rows) {
      if (typeof r.drumate !== "undefined") {
        newuser = this.parseJSON(r.drumate);
      }
    }

    yp.await_query(
      `update organisation set owner_id='${newuser.id}'  WHERE sys_id = 1`
    );

    await this.defaultContent(newuser.id);
    this.output.data(newuser);
  }

}

module.exports = __seo_admin;
