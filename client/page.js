const { RuntimeEnv } = require('@drumee/server-core');

const { resolve, join } = require("path");
const { readFileSync, existsSync } = require("fs");
const { readFileSync: readJsonSync } = require("jsonfile");
const { randomBytes } = require('crypto');
const {
  DrumeeCache, sysEnv, Permission, Attr, Events, nullValue, getUiInfo, toArray
} = require("@drumee/server-essentials/lib");
const { END, GRANTED } = Events;
const { READ } = Permission;
const { main_domain, endpoint_path, server_dir } = sysEnv();

const TPL_BASE = "templates";
const pageLanguage = require("./page-language");
class MainPage extends RuntimeEnv {
  /**
   * Propert isServingPage tells to Acl to grant access, since we
   * are serving only frontend code.
   * In case there a homepage defined, Acl shall be done locally
   * @param {*} opt 
   */
  initialize(opt) {
    this.isServingPage = 1;
    let permission = { src: READ };
    super.initialize({ ...opt, permission });
    this.on(GRANTED, async () => {
      await this.start({ access: GRANTED });
    });
  }

  /**
   *
   */
  static hash() {
    let { hash } = getUiInfo();
    if (hash) {
      console.log(`Page hash=${hash}`);
    }
    return hash;
  }

  /**
   *
   */
  async shouldSendHomepage(data) {
    let tag = new RegExp("^/-/")
    if (!/^\/.*(.+)\.(.+)/.test(data.homepage)) {
      return false;
    }

    let node = await this.yp.await_proc(
      `${data.db_name}.mfs_access_node`,
      this.uid, resolve('/', data.homepage)
    );
    if (node && (node.permission)) {
      let file = resolve(node.home_dir, node.id, `orig.${node.ext}`);
      let html = readFileSync(file);
      this.output.set_header(
        "Access-Control-Allow-Origin",
        `*.${main_domain}`
      );
      html = html.toString();
      this.output.html(html);
      this.session.trigger(END);
      return true;
    }
    return false;
  }

  /**
   * Temp patch: remove legacy cookie
   * @param {*} opt 
   */
  clearLegacyCookie(host, keysel) {
    //this.debug("AAA:84", { host, keysel }, this.input.cookie(keysel))
    if (this.input.cookie(keysel)) {
      this.output.clearAuthorization({ host, keysel });
    }
  }

  /**
  * 
  */
  refreshAuthorization(data) {
    let { id, keysel } = this.input.authorization();
    let host = main_domain;
    // Isolate the DMZ/share session onto its OWN host-scoped cookie in two cases:
    //   (1) the resolved hub is a dmz/share area (per-workspace vhost link), or
    //   (2) the connect host is the NEUTRAL share host `share.<main_domain>` — where
    //       the bootstrap hub is the generic fallback (not a dmz/share area), so
    //       without this the session would fall back to the apex-scoped `regsid`.
    // The critical safety property is `host = this.input.host()`: the cookie is scoped
    // to the CONNECT host (share.<main_domain> on the neutral host), which is NARROWER
    // than the apex `main_domain`, so this session cookie can NEVER be read as the
    // auth (regsid) session on app.drumee.com. That makes a DMZ-session → auth-session
    // rebind structurally impossible here — for authenticated AND anonymous viewers
    // (Lexis prod issue #3). The dmz.login regsid guard remains as belt-and-suspenders.
    const isNeutralShareHost = this.input.host() === `share.${main_domain}`;
    if (/^(dmz|share)$/.test(data.area) || isNeutralShareHost) {
      data.icon = `${endpoint_path}/avatar/${data.owner_id}?type=vignette`;
      keysel = this.hub.get(Attr.id);
      host = this.input.host();
      // The hub cookie must use its own independent session so that
      // cookie_touch in dmz.login (which sets uid = dmz guest) cannot
      // overwrite the authenticated user's regsid session and force a
      // login prompt when they navigate back.  Reuse an existing separate
      // hub session if one is already in place; otherwise issue a fresh
      // one — dmz.login's cookie_touch will register it in the session store.
      const regsidVal = this.input.cookie(Attr.regsid);
      const existingHubSid = this.input.cookie(keysel);
      if (!existingHubSid || existingHubSid === regsidVal) {
        id = randomBytes(16).toString('hex');
      } else {
        id = existingHubSid;
      }
    }

    if (nullValue(keysel)) keysel = Attr.regsid;
    let args = {
      id,
      keysel,
      host,
    }
    this.output.setAuthorization(args);
    this.clearLegacyCookie(host, 'xia_sid');
    this.clearLegacyCookie(host, 'guest_sid');
    this.clearLegacyCookie(host, 'session_type');
    return keysel;
  }

  /**
   * 
   */
  getCustomPlugins() {
    /** Get plugins path from hub settings */
    let { plugins } = this.hub.get(Attr.settings) || {};
    if (!plugins) return null;
    let Plugins = []
    /** Read plugins settings the path */
    for (let [path, entry] of Object.entries(plugins)) {
      let index = join(path, 'index.json');
      if (!existsSync(index)) continue;
      let info = readJsonSync(index)
      if (!info || !info.location) continue;
      if (!/.+\/$/.test(info.location)) {
        info.location = `${info.location}/`;
      } else {
        info.location = info.location.replace(/\/+$/, '/')
      }
      Plugins.push({ ...info, entry: `${entry}-${info.hash}.js` })
    }
    if (Plugins.length) {
      return Plugins
    }
    return null;
  }

  /**
   *
   */
  async start(opt) {
    // Deterministic page language: stored profile choice or English — see
    // client/page-language.js. The old chain ended in Accept-Language, so a
    // browser listing French got a French-rendered page (html lang +
    // bootstrap lang) even in an English account.
    const lang = pageLanguage(this);
    let lex = DrumeeCache.lex(lang);
    const env = await this.getRuntimeEnv();
    let data = { ...lex, ...this.hub.toJSON(), ...env, ...opt };
    // getRuntimeEnv computes its own language via the Accept-Language
    // chain — override it so the template renders the deterministic one.
    data.language = lang;
    if (data.ws_port && !/^:/.test(data.ws_port)) {
      data.ws_port = `:${data.ws_port}`
    }

    let sent = await this.shouldSendHomepage(data);
    await this.session.log_service();
    if (sent) {
      return;
    }
    data.keysel = this.refreshAuthorization(data);
    let db = this.hub.get(Attr.db_name);
    data.fonts_links = await this.yp.await_proc(`${db}.get_fonts_links`);
    data.fonts_faces = await this.yp.await_proc(`${db}.get_fonts_faces`);
    data.description = data.description || data.title;
    this.output.set_header(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );
    this.output.set_header("Access-Control-Allow-Origin", `*.${main_domain}`);
    this.output.set_header("Pragma", "no-cache");
    this.output.set_header("Expires", "0");
    this.set({ data });
    if (this.input.get('debug-ui')) {
      data.debugUi = 1;
    }
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
    let xid = this.input.get("xid")
    if (xid) {
      let opt = { xid, source: xid, service: "page.index" };
      this.session.log_service(opt);
    }
    const template_dir = resolve(__dirname, TPL_BASE);
    let content = this.getRender(template_dir, "index.tpl")(data);
    this.output.html(content);
    this.session.trigger(END);
  }
}

module.exports = MainPage;
