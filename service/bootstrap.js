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
const { readFileSync, existsSync } = require('fs');
const { readFileSync: readJson } = require('jsonfile');
const { join, resolve, extname, dirname, basename } = require('path');
const keyFile = '/etc/drumee/credential/crypto/public.pem';
const { RuntimeEnv } = require('@drumee/server-core');
const { uniqueId, Attr, sysEnv } = require("@drumee/server-essentials");
const TPL_BASE = "client/templates";

class __bootstrap extends RuntimeEnv {

  /**
   * 
   */
  async js() {
    let data = await this.getRuntimeEnv();
    data = { ...this.hub.toJSON(), ...data };
    let auth = this.input.authorization();
    data.keysel = auth.keysel || Attr.regsid;
    this.set({ data });
    this.output.setAuthorization(auth);
    const template_dir = resolve(__dirname, '..', TPL_BASE);
    // let bundles = {}
    // for (let m of ["core", "sprite", "locale", "entry"]) {
    //   bundles[m] = data.app[m]
    // }
    // data.bundles = bundles;
    let bundles = {}
    if (data.app.manifest) {
      for (let m of ["runtime", "core", "sprite", "locale", "main"]) {
        bundles[m] = data.app.manifest[`${m}.js`]
      }
    } else {
      for (let m of ["core", "sprite", "locale", "entry"]) {
        bundles[m] = data.app[m]
      }
    }
    data.bundles = bundles;
    data.isPlugin = 1;
    let content = this.getRender(template_dir, "bootstrap.js.tpl")(data);
    this.output.javascript(content);
  }

  /**
   * 
   */
  async plugin() {
    let name = this.input.get(Attr.name) || '';
    let ext = new RegExp(extname(name) + '$');
    name = name.replace(ext, '')
    const { ui_home, endpoint_path, runtime_dir, endpoint_name } = sysEnv();
    let plugin_base = join(ui_home, '../..', 'plugins', 'ui', endpoint_name);
    let plugin_info = join(plugin_base, name, 'index.json');
    let info;
    if (existsSync(plugin_info)) {
      info = readJson(plugin_info)
    } else {
      plugin_info = join(runtime_dir, 'plugins', 'ui', name, 'index.json');
      if (existsSync(plugin_info)) {
        info = readJson(plugin_info)
      }
    }
    let path = ''
    if (info && info.entry) {
      path = join(endpoint_path, 'plugins', name, info.entry)
    }
    this.output.data({ path });
  }

  /**
   * 
   */
  async css() {
    const template_dir = resolve(__dirname, '..', TPL_BASE);
    let content = this.getRender(template_dir, "fonts.tpl")();
    this.output.text(content, "text/css");
  }

  /**
   * 
   */
  async dom() {
    let type = 'text/javascript';
    let data = await this.getRuntimeEnv();
    data = { ...this.hub.toJSON(), ...data, type };
    let auth = this.input.authorization();
    data.host = this.input.host();

    data.keysel = auth.keysel || Attr.regsid;
    this.set({ data });
    this.output.setAuthorization(auth);
    const template_dir = resolve(__dirname, '..', TPL_BASE);
    let content = this.getRender(template_dir, "bootstrap.dom.tpl")(data);
    this.output.javascript(content);
  }

  /**
   * 
   */
  async publicKey() {
    if (existsSync(keyFile)) {
      let key = readFileSync(keyFile);
      this.output.text(key);
    } else {
      this.output.text("-----NO PUBLIC KEY-----");
    }
  }

  /**
   * 
   */
  async report_error() {
    const { msg, url, stack } = this.input.data() || {};

    // Drop noise from the user's browser, not from Drumee: extension content
    // scripts (wallet provider collisions, etc.) and benign recurring warnings.
    // Mirrors the client-side filter in client/templates/scripts.tpl, so even
    // older cached clients still running the unfiltered script are covered here.
    const haystack = `${url || ''}${stack || ''}`;
    const isExtension = /(chrome|moz|safari(-web)?)-extension:\/\//.test(haystack);
    const isNoiseMsg = [
      /Cannot redefine property:\s*(ethereum|solana|web3|tron(Link|Web)?|keplr)/i,
      /Cannot (set|assign to read only) property '?(ethereum|solana)'?/i,
      /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i,
      /AbortError|The (operation was aborted|user aborted a request)/i,
    ].some((re) => re.test(msg || ''));

    if (isExtension || isNoiseMsg) {
      return this.output.text("OK");
    }

    this.warn("client_error", { msg, url, stack });
    this.output.text("OK");
  }

  /**
   * 
   */
  async authn() {
    let token = uniqueId(22);
    let auth = this.input.authorization();
    let otp_key = this.user.get('otp_key');
    let data = { token };
    if (otp_key) data.otp_key = otp_key;
    if (/^(dmz|share)$/.test(this.hub.get(Attr.area))) {
      auth.type = Attr.guest;
    }
    await this.yp.await_proc(`authn_store`, token, auth);
    this.output.data(data);
  }

  /**
   * 
   */
  getSyncTimes() {
    const t2 = this.input.timestamp();
    const t3 = Date.now()
    this.output.data({ t2, t3 });
  }

}

module.exports = __bootstrap;
