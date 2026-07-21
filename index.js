
const { DrumeeCache, Events } = require("@drumee/server-essentials");
const { END, ERROR, ROUTER_READY, START } = Events;
const HttpServer = require("http");
const { server: SocketServer } = require("websocket");
const Page = require("./client/page");

// The accept-language singleton (used by server-core input.language()) parses
// NOTHING until languages() is called — uninitialized, .get() returns null for
// every header, so input.language() fell through to its hardcoded 'fr' and the
// page shell served <html lang="fr"> to EVERY visitor regardless of browser
// language (mixed fr/en UI). Initialize once per process; module is shared
// with server-core through node's require cache. 'en' first = default for
// missing/unsupported Accept-Language.
require("accept-language").languages(["en", "fr", "es", "ru", "km", "zh"]);

const configs = require("./configs");
const env = configs.env();
configs.load();
const { Session, Input, Output } = require("@drumee/server-core");
const { Router } = require("./router/push")(env);

let timeout = null;
let timer = 1000;
let SEQ = 0;

Page.hash();

/***
 *
 */
function requestHandler(request, response) {
  const input = new Input({ request, sourceName: "page" });
  const output = new Output({ response });
  let session = new Session({ input, output, env });
  let seq = SEQ.toString();
  seq = seq.padStart(10, ".");
  session.on(START, function () {
    SEQ++;
    session.on(END, () => {
      session.stop();
      console.log(`Stoping PAGE ${seq} `);
    });

    session.on(ERROR, function (e) {
      console.error("SERVER_FAULT[43]", e);
      if (session.exception)
        session.exception.server("SERVER_FAULT SESSION_PAGE_ERROR");
      session.stop();
    });

    env.yp.on(ERROR, (msg, ctx) => {
      console.error("SERVER_FAULT[49]", msg);
      if (session) {
        if (session.exception)
          session.exception.server("SERVER_FAULT DB_PAGE_ERROR");
        if (session.stop) session.stop();
      }
    });

    try {
      new Page({ session });
    } catch (e) {
      console.error("SERVER_FAULT[31]", e);
      if (session.exception) session.exception.server("SERVER_FAUL PAGE_ERROR");
      session.stop();
    }
  });
}

/**
 *
 * @returns
 */
function retry(request, response) {
  console.log(`Waiting for Redis Server. Retry in ${timer / 1000} seconds`);
  if (global.websocketRouter) {
    requestHandler(request, response);
    if (timeout) {
      clearTimeout(timeout);
    }
    timer = 1000;
    return;
  }
  if (timer < 15000) {
    timer = timer * 2;
  }
  timeout = setTimeout(() => {
    retry(request, response);
  }, timer);
}

/**
 *
 * @param {*} request
 * @param {*} response
 * @returns
 */
let handler = function (request, response) {
  if (global.websocketRouter) {
    handler = requestHandler;
    requestHandler(request, response);
    return;
  }
  timeout = setTimeout(() => {
    retry(request, response);
  }, timer);
};

// ========================================
// HTTP SERVER
// ========================================
const http = HttpServer.createServer(handler);

// ========================================
// WEBSOCKET SERVER
// ========================================

Router.once(ROUTER_READY, async function () {
  console.log("START WEBSOCKET SERVER...", env.endpointAddress);
  await env.yp.await_proc("socket_reset", env.endpointAddress);
  new DrumeeCache();
  await DrumeeCache.load();
  global.Cache = DrumeeCache;
  const wsServer = new SocketServer({
    httpServer: http,
    autoAcceptConnections: false,
  });

  wsServer.on("request", function (request) {
    try {
      Router.create_connection(request)
        .then()
        .catch((e) => {
          console.warn("ERR[120]:CONNECTION REFUSED:", request.key, e);
          Router.releaseConnection(request.key, 4000);
        });
    } catch (e) {
      console.warn("FAILED TO ROUTE WS : ", e);
      Router.releaseConnection(request.key, 1011);
    }
  });
  wsServer.on("error", function (e) {
    console.warn("Websocket Server Error : ", e);
  });
});

http.listen(env.pushPort);
configs.handleSignals(async () => {
  console.log("Reloading Page Server");
  const { loadSysEnv } = require("@drumee/server-essentials");
  await Cache.load(env.yp, 1);
  loadSysEnv()
});