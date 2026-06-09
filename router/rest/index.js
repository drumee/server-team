
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
      worker.once(GRANTED, function () {
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
