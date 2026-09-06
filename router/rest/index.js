
const WRONG_API = "WRONG_API";

const {
  permissionValue, sysEnv, Events
} = require("@drumee/server-essentials");
const {
  DENIED,
  ERROR,
  GRANTED,
} = Events;
const { isFunction, isString, isArray } = require("lodash");
const { resolve, join, dirname } = require("path");
const { readFileSync } = require("jsonfile");
const { existsSync, statSync } = require("fs");

let Modules = new Map();
let Workers = new Map();
let Plugins = new Map();
let LOCKED = false;

// A3 secure-share: anonymous recipients carry a read-only session privilege ceiling
// (set in dmz.js _loginSecureShare via set_session_priv_ceiling). When a ceiling is
// present, mutating operations are denied. A `permission.src > read` threshold catches
// every write/delete/admin/owner service; the denylist below catches services that are
// read/anonymous src yet still MUTATE (a threshold alone would miss them — e.g.
// channel.post posts chat AS the creator). Audited across all acl/*.json 2026-06-18.
const READ_LEVEL = permissionValue("read");
// Stored cumulative privilege (lib/privilege.js) for the chat cap — a chat-ceiling
// session may post to a folder conversation (channel.post); a lower (read-only)
// ceiling may not. Recipients never get a ceiling above this (edit = no ceiling).
const CHAT_CEILING = 7;
const SECURE_SHARE_READONLY_DENYLIST = new Set([
  // chat / channel — read-src, mutate or impersonate the creator
  "channel.post", "channel.file_thread_post", "channel.delete", "channel.post_ticket", "channel.send_ticket",
  "channel.bookmark_add", "channel.bookmark_remove", "chat.attachment",
  // Read-only but creator-bound secure-share sessions must not probe the
  // creator's workspace chat memberships.
  "chat.forward_eligibility",
  // channel.react: read-src but mutates message metadata (toggle emoji reaction).
  // chat.react is write-src → already caught by the threshold below.
  "channel.react",
  // read-src but persist read receipts for this.uid (creator-bound on anon shares)
  "channel.acknowledge", "channel.read", "channel.acknowledge_ticket",
  // read-src but broadcasts an arbitrary event to the whole hub as the creator
  "conference.broadcast",
  // tags — anonymous-src but mutate the bound hub's tags
  "tag.store", "tag.delete",
  // file copy / restore — read-src, mutate / exfil
  "media.copy", "media.copy_all", "media.restore", "media.restore_into", "media.mark_as_seen",
  // calls / conferences / rooms / signaling — read or anon src; recipients get no calls
  "conference.join", "conference.leave", "conference.update", "conference.accept", "conference.decline",
  "room.join", "room.leave", "room.requestAccess", "room.request_screen_access", "room.get_screen",
  "room.get", "room.unified_room",
  "signaling.dial", "signaling.message",
  // transferbox — read/anon src, mutate
  "transfer.delete", "transfer.remove", "transfer.send_otp",
  // membership / inbound-share / notification mutations — anon|read src, would run as
  // the creator-bound session: leave_hub could remove the CREATOR from the shared hub;
  // sharebox.* accept/refuse the creator's pending shares; activity.dismiss_rollup
  // mutates the creator's notification state; hub.poke sends notifications as the
  // creator; hub.accept_invite redeems an invite AS the creator; yp.device_registration
  // (anon) would bind the viewer's push token to the creator's account.
  "desk.leave_hub", "sharebox.accept_notification", "sharebox.refuse_notification",
  "activity.dismiss_rollup", "hub.poke", "hub.accept_invite", "yp.device_registration",
  // admin mimic (anon-src) + process-wide debug toggles (read-src) — would change
  // impersonation / logging state while bound as the creator.
  "adminpanel.mimic_active", "adminpanel.mimic_reject", "adminpanel.mimic_end_byuser",
  "devel.verbosity", "devel.log_over_socket",
]);

// Downgrade over-limit clamp (service/lib/over-limit.js). While an org is
// over its downgraded plan's limits the whole workspace is read-only; these
// MUTATING services survive the clamp because they are the way OUT of it:
//   - trash / purge / empty_bin free storage (trash still counts toward
//     usage, so purging is the resolving action, not deleting);
//   - member removal frees seats (both console backends);
//   - server_export honours "export always works" (src:'delete', so the
//     mutating threshold would eat it);
//   - drumate.logout is src:'owner' — a locked member must still sign out.
// payment.* / promo.* are allowed by prefix below — the owner must be able
// to upgrade or re-subscribe their way out.
const OVER_LIMIT_MUTATING_ALLOWLIST = new Set([
  "media.trash", "media.purge", "media.empty_bin",
  "media.server_export",
  "adminpanel.member_delete", "admin.hub_member_remove",
  "drumate.logout",
  // Google Drive migration is OFF while locked (an import only ADDS bytes) —
  // the whole src:'owner' namespace stays clamped. These two are the
  // exception: seeing a migration that was already running when the lock
  // landed, and STOPPING it, make the overage smaller, not bigger.
  "google_drive.get_state", "google_drive.cancel",
]);
// Once hard-locked, NON-admin members are denied entirely — not even read
// (Owner/Admin keep view + resolution access). The FE still needs enough to
// boot into the "workspace locked" screen and leave.
const HARD_LOCK_SURVIVAL = new Set([
  "yp.get_env", "desk.get_env", "yp.guest_logout", "drumate.logout",
]);
const ADMIN_LEVEL = permissionValue("admin");


/**
 *
 * @param {*} worker
 * @param {*} session
 * @param {*} svc
 */
async function exec(worker, session, svc, logService) {
  const { service, method } = svc || {};
  if (!worker) {
    console.error(`Failed at ${__filename}:25`, svc);
    session.exception.user(`WORKER_NOT_FOUND:${service}`);
    //throw "No worker was provide!";
    return;
  }
  if (!worker.constructor) {
    console.error(`Failed at ${__filename}:33`, svc);
    session.exception.user(`WORKER_INVALID:${service}`);
    return;
  }

  const instanceName = worker.constructor.name;
  if (!worker[method]) {
    session.exception.user(`SERVICE_NOT_FOUND:${service}`);
    worker.stop();
    return;
  }
  let task = worker[method].bind(worker);

  function failed(e) {
    console.warn(`${instanceName} FAILED TO RUN SERVICE **${service}**`, e);
    session.exception.user(`SERVICE_FAILED:${service}`);
    worker.stop();
  }

  function end(res) {
    //console.info(`|........... ${service} DONE ............`, worker.permission);
  }

  try {
    if (logService) session.log_service();
  } catch (e) {
    console.info(`[ERR:58] ${instanceName} FAILED TO LOG **${service}**`, e);
  }

  if (isFunction(task)) {
    //console.info(`   :::: STARTING ::::: ${service} `, (task.constructor.name==="AsyncFunction"));
    try {
      await task();
      end();
    } catch (e) {
      failed(e);
    }
  } else {
    session.exception.reject(WRONG_API);
    worker.stop();
    console.error(`Module ${instanceName} doesn't have method ${method}`);
  }
}

/**
 *
 * @param {*} dir
 */
async function registerModules(dir, isPlugin, force) {
  const { readdir } = require("fs/promises");
  console.log(`Registering modules from ${dir}`);
  if (!existsSync(dir)) {
    try {
      statSync(dir)
    } catch (e) {
      console.log(e)
    }
    console.warn(
      `Attempted to register modules from invalid directory ${dir}. Skiepped.`,
    );
    return;
  }
  const files = await readdir(dir);
  for (const file of files) {
    if (!/\.json$/i.test(file)) continue;
    let path = resolve(dir, file);
    let mod_name = file.replace(/\.json$/i, "");
    let content = readFileSync(path);
    if (Modules.get(mod_name)) {
      if (!force) {
        console.warn(
          `Module ${mod_name} already exists. Won't override`,
          dir,
          /*content*/
        );
        console.trace()
        continue;
      }
    }
    if (content.modules) {
      for (let k in content.modules) {
        let filepath = content.modules[k].replace(/\.js$/i, "");
        if (!/^\//.test(filepath)) {
          filepath = resolve(dir, filepath);
        }
        filepath = `${filepath}.js`;
      }
      content.workdir = dirname(dir);
    }
    console.log(`... module ${mod_name}`);
    if (isPlugin) {
      Plugins.set(mod_name, content);
    }
    Modules.set(mod_name, content);
  }
}

/**
 *
 * @param {*} error
 * @param {*} reason
 * @returns
 */
function complain(error, reason) {
  return { error, reason };
}

/**
 * 
 */
class Acl {
  _instance = {};
  /**
   * Singleton Client
   * @returns
   */
  constructor() {
    if (Acl._instance) {
      return Acl._instance;
    }
    return (Acl._instance = this);
  }

  /**
   *
   * @param {*} service
   * @returns
   */
  static getModule(service, isAnonymous) {
    let mod_name, func_name;
    let error = "WORKER_NOT_FOUND";
    let Path = require("path");
    let access = isAnonymous ? "public" : "private";
    service = service.replace(/[\?\&].*$/, "");
    try {
      [mod_name, func_name] = service.split(/\.+/);
    } catch (e) {
      return complain(error, `Wrong service format (${service})`, e);
    }
    if (!mod_name || !func_name) {
      return complain(
        `WRONG_SERVICE_FORMAT`,
        `<${service}> is not a valid service format`
      );
    }
    let data = Modules.get(mod_name);
    if (!data || !data.modules) {
      return complain(
        "MODULE_NOT_FOUND",
        `Could not find module '${mod_name}'`
      );
    }
    if (!data.services) {
      return complain(
        "SERVICES_NOT_FOUND",
        `Not service has been registered for the module ${mod_name}`
      );
    }
    if (data.services[func_name]) {
      let { scope, permission, method, log } = data.services[func_name] || {};
      let mod_path = data.modules[access];
      if (!mod_path) {
        return complain(
          `MODULE_NOT_FOUND`,
          `${mod_name} not found for ${access} access}`
        );
      }
      if (!permission) {
        return complain(
          `SERVICE_NOT_FOUND`,
          `Undefined permission for service ${mod_name}.${func_name}`
        );
      }

      method = method || func_name;
      if (permission.src) permission.src = permissionValue(permission.src);
      if (permission.dest) permission.dest = permissionValue(permission.dest);
      permission.scope = scope;
      let pwd = data.workdir || __dirname;
      let path = Path.resolve(pwd, `${mod_path}.js`);
      return { path, permission, method, service, logService: log };
    }
    return complain(
      "SERVICE_NOT_FOUND",
      `Service **${service}** not found from module ${mod_name}`
    );
  }

  /**
   *
   */
  static run(session) {
    let msg, access;

    let service = session.input.get("service");

    if (service == null) {
      try {
        const params = session.request.headers["x-param-xia-data"];
        if (isString(params)) {
          service = JSON.parse(params).service;
        }
      } catch (e) {
      }
    }

    if (service == null) service = "page.index";

    const { path, permission, method, error, reason, logService } =
      Acl.getModule(service, session.isAnonymous());

    if (error) {
      console.info(reason);
      session.exception.unauthorized(error);
      return;
    }

    let worker;
    try {
      //console.info(`Running ${service} --> ${service}`, path, permission);
      let WorkerClass = Workers.get(path);
      if (!WorkerClass) {
        console.info(`Loading worker for ${service}`, { path, permission });
        WorkerClass = require(path);
        Workers.set(path, WorkerClass);
      }
      worker = new WorkerClass({ session, permission });
      worker.once(GRANTED, async function () {
        // A3: enforce the read-only ceiling for secure-share recipient sessions.
        // Only look up the ceiling when this service COULD mutate (write+ src, or a
        // read/anon-src mutator) → normal read traffic adds no DB cost. Fail-OPEN on
        // lookup error so a missing SP / DB hiccup degrades to today's behaviour and
        // never blocks all writes. Self-clears via uid==ceiling_uid in the SP.
        // A service can also mutate via its DESTINATION (e.g. media.relocate is
        // src:read, dest:write → move_all): the src threshold alone would miss it and
        // let a clamped session move files. Treat dest write+ as mutating too.
        const mightMutate = (permission && permission.src > READ_LEVEL)
          || (permission && permission.dest != null && permission.dest > READ_LEVEL)
          || SECURE_SHARE_READONLY_DENYLIST.has(service);
        if (mightMutate) {
          try {
            // get_session_priv_ceiling is a PROCEDURE (CREATE FUNCTION is restricted
            // under binary logging on the replicated DB; procedures are not) → await_proc.
            // It SELECTs a single row {priv_ceiling}; null when unset or uid != ceiling_uid.
            let _row = await session.yp.await_proc("get_session_priv_ceiling", session.sid());
            if (Array.isArray(_row)) _row = _row[0];
            const ceiling = (_row && _row.priv_ceiling != null) ? _row.priv_ceiling : null;
            if (ceiling != null) {
              // A chat ceiling (>=7) permits posting to a folder conversation
              // (channel.post) and to a file-thread chat (channel.file_thread_post)
              // while still denying file-writes/calls/invite; a read-only ceiling (3)
              // denies both. Everything else stays denied for any ceiling.
              const chatPostAllowed = (ceiling >= CHAT_CEILING &&
                (service === "channel.post" || service === "channel.file_thread_post"));
              if (!chatPostAllowed) {
                worker.stop();
                return session.exception.unauthorized(`SECURE_SHARE_READ_ONLY:${service}`);
              }
            }
          } catch (e) {
            console.warn("[acl] secure-share ceiling check failed (fail-open):", e && e.message);
          }
        }
        // Which organisation is this request acting in? Resolved once, here,
        // before anything reads it — the clamp below is the first consumer and
        // every worker is the next. Stashed on session.user so a worker reads
        // it with a plain get() and no import.
        //
        // This is a no-op today: nobody holds a second membership, so it
        // resolves to home for all 306 accounts. It is placed here rather than
        // inside each service because the clamp immediately below is one of
        // the sites that has been asking the wrong question.
        try {
          const ActingDomain = require("../../service/lib/acting-domain");
          const acting = await ActingDomain.resolve(session);
          if (acting > 0 && session.user) {
            session.user.set("acting_domain_id", acting);
          }
        } catch (e) {
          // resolve() does not throw; this guard is for the require itself.
          console.warn("[acl] acting domain resolution failed (fail-open):", e && e.message);
        }
        // Downgrade over-limit read-only clamp. One cached, indexed yp read
        // (30s TTL inside getState) per domain; personal domains (id<=1) and
        // platforms without over_limit_enforcement never reach the lookup.
        // Fail-OPEN like the ceiling above — a failed check keeps the last
        // known state and never invents a lock.
        //
        // The domain here is the ACTING one, not home. Keyed on home it got
        // the question backwards in both directions: someone whose home org
        // was hard-locked was clamped inside a perfectly healthy org they had
        // switched into, and — the expensive half — someone whose home was
        // fine BYPASSED the lock of the org they were actually filling up. The
        // clamp exists to stop writes into an over-limit org, so it has to ask
        // about the org being written to.
        try {
          const OverLimit = require("../../service/lib/over-limit");
          if (OverLimit.enabled() && session.user && session.user.get("signed_in")) {
            const dom = ~~(session.user.get("acting_domain_id") || session.user.domain_id());
            if (dom > 1) {
              const st = await OverLimit.getState(session.yp, dom);
              if (st && (st.state === "over_limit" || st.state === "hard_lock")) {
                const uid = session.user.get("id");
                if (st.state === "hard_lock" && !HARD_LOCK_SURVIVAL.has(service)) {
                  // Owner/Admin keep view + resolution access; every other
                  // role is denied entirely — not even read.
                  let admin = uid && uid === st.owner_id ? 1 : 0;
                  if (!admin) {
                    admin = await session.yp.await_func("domain_permission", uid, dom, ADMIN_LEVEL);
                  }
                  if (!admin) {
                    worker.stop();
                    return session.exception.unauthorized(`HARD_LOCK_DENIED:${service}`);
                  }
                }
                // admin./adminpanel. pass as a family: their src:'admin' is a
                // PRIVILEGE requirement, not a mutation marker — the threshold
                // below would read every admin-console READ (member_stats,
                // member_list, audit) as mutating and lock the owner out of
                // the very console that resolves the overage. Nothing in
                // these namespaces grows usage or seats: invites go through
                // hub.invite (still clamped), uploads through media.*.
                const survives = OVER_LIMIT_MUTATING_ALLOWLIST.has(service)
                  || service.startsWith("payment.")
                  || service.startsWith("promo.")
                  || service.startsWith("admin.")
                  || service.startsWith("adminpanel.");
                if (mightMutate && !survives) {
                  worker.stop();
                  return session.exception.unauthorized(`OVER_LIMIT_READ_ONLY:${service}`);
                }
              }
            }
          }
        } catch (e) {
          console.warn("[over-limit] clamp failed (fail-open):", e && e.message);
        }
        const need = worker.before_granting;
        if (isFunction(worker[need])) {
          try {
            worker.once(`${need}-done`, () => {
              // console.log(`ACCESS GRANTED TO RUN ${service}[${method}][precheck=${need}]`)
              exec(worker, session, { method, service }, logService);
            });
            worker[need]();
          } catch (e) {
            worker.stop();
            console.error("PRECONDITION_FAILED", e);
          }
          return;
        }
        try {
          exec(worker, session, { method, service }, logService);
        } catch (e) {
          console.error("EXECUTION_FAILED", worker, e);
          session.exception.user(WRONG_API);
        }
      });

    } catch (error) {
      const e = error;
      console.info(
        `Could not run method ${service} with ${access} privilege`,
        e
      );
      console.error("SERVICES TABLE =>.", permission);
      session.exception.reject(WRONG_API);
      if (worker != null) {
        worker.stop();
      }
    }
  }

  /**
   * Load modules definitions from the passed directory
   */
  static async loadModules(dirname) {
    await registerModules(join(dirname, "acl"));
  }

  /**
   * Load modules definitions from the passed directory
   */
  static getServices() {
    if (!Modules.size) {
      return {};
    }

    let r = {};
    for (let name of Modules.keys()) {
      let { services } = Modules.get(name);
      r[name] = {};
      for (let k in services) {
        r[name][k] = `${name}.${k}`;
      }
    }
    return r;
  }

  /**
   * Load modules definitions from the passed directory
   */
  static getPlugins() {
    if (!Plugins.size) {
      return {};
    }

    let r = {};
    for (let name of Plugins.keys()) {
      let { services } = Plugins.get(name);
      r[name] = {};
      for (let k in services) {
        r[name][k] = `${name}.${k}`;
      }
    }
    return r;
  }

  /**
   * Load modules definitions from the passed directory
   */
  static async loadPlugins(force = false) {
    if (force) LOCKED = false;
    if (LOCKED) {
      console.error("[REST ROUTER]:[353] DYNAMIC LOADING IS NOT ALLOWED !");
      return;
    }
    const { plugins_dir, endpoint_name } = sysEnv();
    let file = join(plugins_dir, `${endpoint_name}.json`);
    if (!existsSync(file)) {
      return;
    }
    let { acl } = readFileSync(file) || {};
    if (!acl || !isArray(acl)) {
      console.warn(
        `No ACL definition was found from ${file}. No plugins has been loaded`
      );
      return;
    }
    //console.log(`Loading plugins from ${file}`);
    for (let dir of acl) {
      let plgin = join(dir, "acl");
      try {
        statSync(plgin)
      } catch (e) {
        console.warn(`Could not load plugin acl file ${plgin}`, e);
        return;
      }
      if (!existsSync(plgin)) {
        console.warn(`A folder name 'acl' must exist within directory ${dir}`);
      }
      console.log(`Loading pulgin for ${plgin}`);
      await registerModules(plgin, true, force);
    }
    // Once the lock is set, no more plugins will be added, unless forced
    LOCKED = true;
  }
}

module.exports = Acl;
