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
const {
  Attr, Constants, Cache, toArray, RedisStore, sysEnv, TFauth
} = require("@drumee/server-essentials");

const {
  ID_NOBODY
} = Constants;
const { isEmpty, isString, isArray } = require("lodash");
const { getServices } = require("../../router/rest");
const { main_domain } = sysEnv();

// const { existsSync, readFileSync } = require("fs");
// const { resolve } = require("path");
// const { credential_dir } = sysEnv();
// let keyFile = resolve(credential_dir, `crypto/public.pem`);
// let publicKey;
// if (existsSync(keyFile)) {
//   let publicKey = readFileSync(keyFile);
// }

const TfaMethods = TFauth.Methods.map((e) => {
  return e.type
});

async function get_env() {
  const yp = this.yp;
  let data = {
  };
  let _def_fonts = await yp.await_query(
    "SELECT * FROM font WHERE family='Roboto' ORDER BY `name` ASC"
  );

  const hub = this.hub.toJSON();
  if (!isEmpty(hub.fonts_faces)) {
    hub.fonts_faces = hub.fonts_faces.concat(_def_fonts);
  }
  if (!hub.exists) {
    this.exception.not_found("HUB_NOT_FOUND");
    return;
  }
  data.hub = { ...data.hub, ...hub };
  this.user.set(Attr.quota, {});
  data.user = await this.yp.await_proc("get_user", this.uid) || {};
  data.user.onboarded = !!(data.user.profile && data.user.profile.onboarded);
  let { usage } = await this.yp.await_proc("disk_usage", this.uid) || {};
  data.user.disk_usage = usage;
  data.user.otp_key = this.session.get('secret');
  data.organization = await this.yp.await_proc("my_organisation", this.uid);
  const { main_domain } = sysEnv();
  if (isEmpty(data.organization)) {
    let host = main_domain;
    if (this.uid == ID_NOBODY) {
      host = this.input.host();
    }
    data.organization = await this.yp.await_proc(
      "organisation_get",
      host
    );
  }
  if (isArray(data.organization)) {
    data.organization = data.organization[0] || {};
  }
  data.organization.useEmail = global.myDrumee.useEmail || 0;
  data.user.is_reseller = 0;
  if (data.organization.metadata) {
    data.user.is_reseller = data.organization.metadata.is_reseller || 0;
  } else {
    data.organization.metadata = {};
  }
  data.user.main_domain = main_domain;
  if (this.user.get("signed_in")) {
    data.user.signed_in = 1;
    data.user.connection = "online";
  } else {
    data.user.signed_in = 0;
    data.user.connection = "offline";
  }
  data.user.privilege = data.organization.privilege; // To be use from withon origanization
  data.main_domain = main_domain;
  data.hub = hub;
  data.platform = this.platform()
  return data;
}

/**
 * 
 * @returns 
 */
function platform() {
  let platform = {};
  platform.fonts = [];
  platform.description = Cache.getSysConf('platform_intro_popup_title');
  if (platform.description) {
    platform.description = JSON.parse(platform.description);
  }
  platform.legals = Cache.getSysConf('legals');
  if (platform.legals) {
    platform.legals = JSON.parse(platform.legals);
  } else {
    platform.legals = {}
  }
  let wp = Cache.getSysConf("wallpaper");
  if (isString(wp)) {
    platform.wallpaper = JSON.parse(wp);
  } else {
    platform.wallpaper = wp;
  }
  platform.intl = this.supportedLanguage();
  platform.arch = global.myDrumee.arch || "pod";
  // Explicit on/off switch for the billing "upgrade plan" affordances
  // (desk sidebar entry + admin-console CTAs), set in
  // /etc/drumee/conf.d/myDrumee.json as `billing_upgrade`.
  //
  //   omitted -> the client derives it (arch 'cloud' + a live payment
  //              service), i.e. the behaviour every existing install
  //              already has; nothing to set to keep things as they are.
  //   0/false -> force OFF everywhere (kill switch).
  //   1/true  -> force ON, overriding the arch check — for a pod that does
  //              have Stripe configured.
  //
  // Deliberately passed through untouched (no ~~/Boolean coercion): the
  // client must be able to tell "unset" from "explicitly 0", and those two
  // mean different things.
  if (global.myDrumee.billing_upgrade !== undefined) {
    platform.billing_upgrade = global.myDrumee.billing_upgrade;
  }
  // Downgrade over-limit enforcement (read-only lock + resolution flow) —
  // same rollout pattern as billing_upgrade: cloud feature, off unless the
  // deployment's myDrumee.json turns it on. Coerced here (unlike above)
  // because the client only needs on/off; there is no "derive it" third
  // state for this one.
  platform.over_limit_enforcement = global.myDrumee.over_limit_enforcement ? 1 : 0;
  // Contextual tutorial sub-tours (desk triggers fire a short tour on the
  // user's FIRST interaction with a surface, once per user ever). Same rollout
  // pattern and same coercion as over_limit_enforcement above: off unless the
  // deployment's myDrumee.json turns it on. Off means the desk keeps today's
  // single post-signup tour and no trigger fires, so this is a true kill
  // switch — the client writes nothing while it is 0.
  platform.contextual_tours = global.myDrumee.contextual_tours ? 1 : 0;
  platform.cdnHost = global.myDrumee.cdnHost;
  platform.version = global.VERSION;
  platform.TfaMethods = TfaMethods;
  if (
    global.myDrumee.isPublic &&
    global.myDrumee.useEmail &&
    global.myDrumee.arch == "cloud"
  ) {
    platform.isPublic = 1;
  }
  if (Cache.getSysConf("plugins")) {
    platform.plugins = JSON.parse(Cache.getSysConf("plugins"));
  }
  platform.services = getServices();
  platform.doc_editor = Cache.getSysConf("doc_editor");
  platform.endpoint = this.input.basepath();
  return platform;
}
/**
* 
* @param {*} args 
* @param {*} opt 
*/
async function createHub(args, opt = {}) {
  let { owner_id, domain, area, filename, hostname, pid, user_db } = args;
  if (!domain || !area) {
    this.warn("MAL_FORMED_DATA", { args }, { domain, area });
    return this.exception.user("MAL_FORMED_DATA");
  }

  if (opt.is_wicket) {
    hostname = uniqueId()
    filename = hostname;
  } else {
    hostname = filename;
    hostname = hostname.replace(/[ \.,;:!&~#'|@*\$><\?\(\)\[\]\{\}\"\/]/g, '');
    hostname = await this.yp.await_func("strip_accents", hostname);
    hostname = hostname.replace(/\-$/, '');
    hostname = hostname.trim().toLowerCase();
    hostname = new URL(`http://${hostname}`).hostname;
  }

  opt.lang = this.input.ua_language();
  filename = await this.yp.await_func(`${user_db}.unique_filename`, pid, filename, "");
  args = { hostname, area, filename, owner_id, domain };
  const rows = await this.yp.await_proc(`${user_db}.desk_create_hub`, args, opt);
  let hub_id, hub_db, home_id;
  for (let r of rows) {
    if (r && r.failed) {
      this.debug("Rows returned", rows)
      this.warn("Failed to create hub", { args, opt, rows });
      return {};
    }
    if (r.db_name && r.filesize != null && r.actual_home_id) {
      hub_db = r.db_name;
      home_id = r.actual_home_id;
    }
    if (r.db_name && r.home_dir) {
      hub_id = r.id;
      hub_db = hub_db || r.db_name;
    }
  }

  /** place the folder at the end on the user desk */
  let { count } = await this.yp.await_query(`SELECT count(*) count FROM ${user_db}.media`);
  await this.yp.await_query(`UPDATE ${user_db}.media media SET rank=? WHERE id=?`, count, hub_id);
  return { filename, hostname, hub_id, hub_db, db_name: hub_db, home_id }

}


module.exports = { get_env, platform, createHub };
