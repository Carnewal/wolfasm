/**
 * shell.js — browser shell for the ET: Legacy WebAssembly client.
 *
 * Loaded by shell.html (which Emscripten bakes into etl.html at link time). It
 * builds the global `Module` object the Emscripten runtime expects and wires up
 * the browser-side concerns that make the game usable and deployable:
 *
 *   - endpoints            same-origin /ws relay and /dl download proxy
 *   - status UI            the loading text + progress bar
 *   - player name          auto-generated on first run (faker, with a fallback)
 *   - home persistence      /etlhome mounted as IDBFS so the profile survives reloads
 *   - download proxy       fetch pure-server pk3s through the Go server's /dl
 *   - engine arguments     base cvars + URL-driven connect/devmap/exec
 *   - auto commands        run name/connect/devmap once the engine is live
 *
 * The unified Go server (bridge/main.go) serves this file, the WebSocket relay
 * and the download proxy from one origin, so everything below is derived from
 * `location` and the same build runs on localhost and on play.wolfasm.com.
 */
(function () {
  'use strict';

  //--------------------------------------------------------------------------
  // Endpoints (same origin as this page)
  //--------------------------------------------------------------------------

  function webSocketBridgeUrl() {
    var override = new URLSearchParams(location.search).get('bridge');
    if (override) {
      return override;
    }
    var scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return scheme + '://' + location.host + '/ws';
  }

  var WEBSOCKET_BRIDGE_URL = webSocketBridgeUrl();
  var DOWNLOAD_PROXY_URL = location.origin + '/dl';

  // Runtime config injected by the Go server (/config.js), with fallbacks for
  // serving statically without it. The master/MOTD addresses are resolved
  // server-side because the browser can't reach those hostnames over UDP.
  var runtimeConfig = window.WOLFASM_CONFIG || {};
  var MASTER_SERVER = runtimeConfig.masterServer || '104.248.140.165:27950';
  var MOTD_SERVER = runtimeConfig.motdServer || '104.248.140.165:27951';

  // Render at the window's size (capped) so the game fills the viewport instead
  // of a fixed 4:3 box. The canvas CSS is 100vw/100vh, so framebuffer == display
  // (1:1, no distortion). Resolution is fixed at load (changing it needs a
  // vid_restart, which is disabled in the browser build); resize = reload.
  var MAX_RENDER_WIDTH = 2560;
  var MAX_RENDER_HEIGHT = 1440;

  function displayDimensions() {
    var width = Math.min(MAX_RENDER_WIDTH, Math.max(640, Math.floor(window.innerWidth)));
    var height = Math.min(MAX_RENDER_HEIGHT, Math.max(480, Math.floor(window.innerHeight)));
    return { width: width, height: height };
  }

  //--------------------------------------------------------------------------
  // In-page log (mirrors console; kept on window.__etlog for debugging)
  //--------------------------------------------------------------------------

  var LOG_TAIL_LIMIT = 6000;
  var logTail = (window.__etlog = window.__etlog || []);

  function log(message) {
    logTail.push(message);
    if (logTail.length > LOG_TAIL_LIMIT) {
      logTail.shift();
    }
  }

  //--------------------------------------------------------------------------
  // DOM
  //--------------------------------------------------------------------------

  var canvasElement = document.getElementById('canvas');
  var statusElement = document.getElementById('status');
  var progressElement = document.getElementById('progress');
  var outputElement = document.getElementById('output');

  function createGameCanvas() {
    // SDL/Emscripten relies on this listener to detect WebGL context loss.
    canvasElement.addEventListener('webglcontextlost', function (event) {
      alert('WebGL context lost. You will need to reload the page.');
      event.preventDefault();
    }, false);
    return canvasElement;
  }

  var PROGRESS_STATUS_PATTERN = /([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/;
  var lastStatus = { time: 0, text: '' };

  function setStatus(text) {
    if (text === lastStatus.text) {
      return;
    }
    var progress = PROGRESS_STATUS_PATTERN.exec(text);
    var now = Date.now();
    if (progress && now - lastStatus.time < 30) {
      return; // throttle rapid progress updates
    }
    lastStatus.time = now;
    lastStatus.text = text;
    if (progress) {
      progressElement.hidden = false;
      progressElement.value = parseInt(progress[2], 10) * 100;
      progressElement.max = parseInt(progress[4], 10) * 100;
      statusElement.textContent = progress[1];
    } else {
      progressElement.hidden = true;
      statusElement.textContent = text;
      if (!text) {
        statusElement.style.display = 'none';
      }
    }
  }

  function printToOutput(text) {
    console.log(text);
    if (outputElement) {
      outputElement.style.display = 'block';
      outputElement.textContent += text + '\n';
      outputElement.scrollTop = outputElement.scrollHeight;
    }
  }

  function joinArguments(args) {
    return args.length > 1 ? Array.prototype.slice.call(args).join(' ') : args[0];
  }

  //--------------------------------------------------------------------------
  // Player name — generated once per browser, persisted in localStorage.
  //--------------------------------------------------------------------------

  var PLAYER_NAME_KEY = 'wolfasm.playerName';
  var FAKER_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@faker-js/faker/+esm';
  var FALLBACK_ADJECTIVES = ['Swift', 'Silent', 'Rusty', 'Brave', 'Grumpy', 'Lucky', 'Sneaky', 'Iron', 'Wired', 'Feral'];
  var FALLBACK_NOUNS = ['Falcon', 'Wrench', 'Panzer', 'Medic', 'Bunker', 'Grenade', 'Radio', 'Sniper', 'Tommy', 'Otter'];

  function capitalizeWords(text) {
    return text.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function generateFallbackName() {
    return pickRandom(FALLBACK_ADJECTIVES) + ' ' + pickRandom(FALLBACK_NOUNS);
  }

  async function generateNameWithFaker() {
    try {
      var mod = await import(FAKER_MODULE_URL);
      return capitalizeWords(mod.faker.word.adjective() + ' ' + mod.faker.word.noun());
    } catch (error) {
      log('faker unavailable, using local name generator: ' + error);
      return generateFallbackName();
    }
  }

  function savedPlayerName() {
    try { return localStorage.getItem(PLAYER_NAME_KEY); } catch (e) { return null; }
  }

  async function resolvePlayerName() {
    var saved = savedPlayerName();
    if (saved) {
      return saved;
    }
    var name = await generateNameWithFaker();
    try { localStorage.setItem(PLAYER_NAME_KEY, name); } catch (e) {}
    return name;
  }

  //--------------------------------------------------------------------------
  // Home directory persistence (IDBFS) + first-run profile seed
  //--------------------------------------------------------------------------

  var HOME_PATH = '/etlhome';
  var PROFILE_DIR = HOME_PATH + '/legacy/profiles';
  var DEFAULT_PROFILE_NAME = 'webplayer';
  var DEFAULT_PROFILE_DAT = PROFILE_DIR + '/defaultprofile.dat';

  var homeReady = false;
  var syncInProgress = false;

  function makeDirectory(path) {
    try { FS.mkdir(path); } catch (e) { /* already exists */ }
  }

  function fileExists(path) {
    try { FS.stat(path); return true; } catch (e) { return false; }
  }

  // Seed a default profile so the engine adopts it at boot (via
  // profiles/defaultprofile.dat -> cl_profile) rather than showing the first-run
  // "create a profile / enter a name" menu. Only seeded when absent, so a profile
  // the player later customises is preserved.
  function seedDefaultProfile() {
    makeDirectory(HOME_PATH + '/legacy');
    makeDirectory(PROFILE_DIR);
    makeDirectory(PROFILE_DIR + '/' + DEFAULT_PROFILE_NAME);
    if (!fileExists(DEFAULT_PROFILE_DAT)) {
      FS.writeFile(DEFAULT_PROFILE_DAT, '"' + DEFAULT_PROFILE_NAME + '"');
    }
  }

  // preRun: mount /etlhome as IDBFS and load its saved contents BEFORE main()
  // runs (gated with a run dependency so the engine sees the profile at startup).
  function mountAndLoadHome() {
    makeDirectory(HOME_PATH);
    try {
      FS.mount(IDBFS, {}, HOME_PATH);
    } catch (error) {
      log('IDBFS mount failed: ' + error);
      homeReady = true;
      return;
    }
    Module.addRunDependency('etlhome-idbfs');
    FS.syncfs(true, function (error) {
      if (error) {
        log('IDBFS load error: ' + error);
      }
      try {
        seedDefaultProfile();
      } catch (seedError) {
        log('profile seed failed: ' + seedError);
      }
      homeReady = true;
      Module.removeRunDependency('etlhome-idbfs');
    });
  }

  // Flush /etlhome back to IndexedDB so the profile/config survive a reload. The
  // engine only writes its config on quit/writeconfig (which never happens in the
  // browser), so optionally nudge it to write the config first.
  function flushHome(writeConfigFirst) {
    if (syncInProgress || !homeReady || !window.Module || !Module.FS) {
      return;
    }
    try {
      if (writeConfigFirst && Module.ccall) {
        runEngineCommand('writeconfig etconfig.cfg');
      }
      syncInProgress = true;
      Module.FS.syncfs(false, function () { syncInProgress = false; });
    } catch (e) {
      syncInProgress = false;
    }
  }

  var PLAIN_FLUSH_INTERVAL_MS = 5000;
  var CONFIG_FLUSH_INTERVAL_MS = 15000;

  function startPersistenceTimers() {
    setInterval(function () { flushHome(false); }, PLAIN_FLUSH_INTERVAL_MS);
    setInterval(function () { flushHome(true); }, CONFIG_FLUSH_INTERVAL_MS);
    window.addEventListener('pagehide', function () { flushHome(true); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { flushHome(true); }
    });
  }

  //--------------------------------------------------------------------------
  // Download proxy — called by the engine (src/sys/dl_emscripten.c) to fetch a
  // pure server's pk3 through the Go server's /dl endpoint and write it to the FS.
  //--------------------------------------------------------------------------

  var DOWNLOAD_IDLE = 0, DOWNLOAD_RUNNING = 1, DOWNLOAD_DONE = 2, DOWNLOAD_FAILED = 3;
  var download = { state: DOWNLOAD_IDLE, received: 0, total: 0 };

  function proxyUrlFor(remoteUrl, origin) {
    return DOWNLOAD_PROXY_URL +
      '?origin=' + encodeURIComponent(origin || 'default') +
      '&url=' + encodeURIComponent(remoteUrl);
  }

  function writeDownloadedFile(localPath, bytes) {
    var lastSlash = localPath.lastIndexOf('/');
    if (lastSlash > 0) {
      try { Module.FS.mkdirTree(localPath.substring(0, lastSlash)); } catch (e) {}
    }
    Module.FS.writeFile(localPath, bytes);
  }

  function beginDownload(remoteUrl, localPath, origin) {
    download.state = DOWNLOAD_RUNNING;
    download.received = 0;
    download.total = 0;
    fetch(proxyUrlFor(remoteUrl, origin)).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      download.total = parseInt(response.headers.get('Content-Length') || '0', 10);
      return response.arrayBuffer();
    }).then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      writeDownloadedFile(localPath, bytes);
      download.received = bytes.length;
      download.state = DOWNLOAD_DONE;
      log('download ok: ' + localPath + ' (' + bytes.length + ' bytes)');
    }).catch(function (error) {
      download.state = DOWNLOAD_FAILED;
      log('download failed ' + remoteUrl + ': ' + error);
    });
  }

  function downloadField(which) {
    if (which === 1) { return download.received | 0; }
    if (which === 2) { return download.total | 0; }
    return download.state | 0;
  }

  function resetDownload() {
    download.state = DOWNLOAD_IDLE;
    download.received = 0;
    download.total = 0;
  }

  //--------------------------------------------------------------------------
  // Engine command line
  //--------------------------------------------------------------------------

  // Read game data from the preloaded /etl package; reach live servers via the
  // same-origin WebSocket relay. rate/snaps are raised because ET's UDP pk3
  // download sends ~1KB per network message gated by those cvars (25000/20 caps
  // downloads at ~5KB/s; 90000/40 lifts it to ~27KB/s and smooths snapshots).
  function baseEngineArguments() {
    var size = displayDimensions();
    return [
      '+set', 'fs_basepath', '/etl',
      '+set', 'fs_homepath', HOME_PATH,
      '+set', 'r_fullscreen', '0',
      // Custom resolution (r_mode -1) sized to the window. The other video cvars
      // are pre-set to the first-run preset values so exec'ing preset_high.cfg
      // does not trigger a mid-frame vid_restart (destabilises the main loop).
      '+set', 'r_mode', '-1',
      '+set', 'r_colorbits', '32',
      '+set', 'r_depthbits', '24',
      '+set', 'r_texturebits', '32',
      '+set', 'r_picmip', '0',
      '+set', 'r_customwidth', String(size.width),
      '+set', 'r_customheight', String(size.height),
      '+set', 'rate', '90000',
      '+set', 'snaps', '40',
      '+set', 'net_wsbridge', WEBSOCKET_BRIDGE_URL,
      // Master/MOTD addresses resolved server-side (see /config.js); the browser
      // can't resolve those hostnames to reachable UDP peers itself.
      '+set', 'com_masterServer', MASTER_SERVER,
      '+set', 'sv_master1', MASTER_SERVER,
      '+set', 'com_motdServer', MOTD_SERVER,
      // Use the saved name immediately if we have one (so the UI shows it from the
      // start); the first-ever load has none yet and gets the generated name
      // applied post-boot (runAutoCommands).
      '+set', 'name', savedPlayerName() || 'Player',
    ];
  }

  // Drive the client straight from the URL — no menu, no rebuild:
  //   ?connect=1.2.3.4:27960   connect to a live server (via the relay)
  //   ?devmap=oasis            load a local map straight into play
  //   ?exec=cmd1;cmd2          run arbitrary console commands
  // connect/devmap are also fired shortly after boot (see runAutoCommands) so
  // they land after cgame/ui init.
  var autoCommand = null;

  function urlDrivenArguments() {
    var extra = [];
    var params = new URLSearchParams(location.search);
    var connect = params.get('connect');
    var devmap = params.get('devmap');
    var exec = params.get('exec');
    if (connect) {
      autoCommand = 'connect ' + connect;
    }
    if (devmap) {
      autoCommand = 'devmap ' + devmap;
      extra.push('+set', 'sv_pure', '0', '+set', 'bot_enable', '0', '+set', 'g_doWarmup', '0');
    }
    if (exec) {
      exec.split(';').forEach(function (command) {
        command = command.trim();
        if (!command) { return; }
        var parts = command.split(' ');
        extra.push('+' + parts[0]);
        parts.slice(1).forEach(function (arg) { extra.push(arg); });
      });
    }
    return extra;
  }

  //--------------------------------------------------------------------------
  // Running console commands once the engine is live
  //--------------------------------------------------------------------------

  function engineIsReady() {
    // calledRun stays false under the infinite main loop, so ccall is the signal.
    return !!(window.Module && Module.ccall);
  }

  function runEngineCommand(command) {
    Module.ccall('ETL_ExecCommand', 'null', ['string'], [command]);
  }

  function whenEngineReady(callback) {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      if (engineIsReady() && attempts >= 6) {
        clearInterval(timer);
        callback();
      } else if (attempts > 40) {
        clearInterval(timer); // give up quietly
      }
    }, 500);
  }

  // Apply the generated player name, then fire the URL auto-command (connect /
  // devmap), in that order so a name is set before we join a server.
  function runAutoCommands(playerNamePromise) {
    whenEngineReady(function () {
      playerNamePromise.then(function (name) {
        try {
          runEngineCommand('set name "' + name.replace(/"/g, '') + '"');
          log('player name: ' + name);
        } catch (e) {}
        if (autoCommand) {
          try { runEngineCommand(autoCommand); } catch (e) {}
          autoCommand = null;
        }
      });
    });
  }

  //--------------------------------------------------------------------------
  // Global error capture (readable via window.__etlog / window.__lasterr)
  //--------------------------------------------------------------------------

  function installGlobalErrorHandlers() {
    window.addEventListener('error', function (event) {
      window.__lasterr = (event && event.error && event.error.stack) ? event.error.stack : String(event && event.message);
      log('WINERR: ' + window.__lasterr);
    });
    window.addEventListener('unhandledrejection', function (event) {
      window.__lasterr = 'REJECT: ' + (event && event.reason && event.reason.stack ? event.reason.stack : String(event && event.reason));
      log(window.__lasterr);
    });
  }

  //--------------------------------------------------------------------------
  // Assemble the Emscripten Module and bootstrap
  //--------------------------------------------------------------------------

  var totalDependencies = 0;

  var Module = {
    canvas: createGameCanvas(),
    preRun: [mountAndLoadHome],
    // Never read stdin via window.prompt() (it blocks the main loop). The tty
    // console is also disabled under __EMSCRIPTEN__ (con_tty.c); this is a
    // belt-and-suspenders EOF.
    stdin: function () { return null; },
    print: function () { printToOutput(joinArguments(arguments)); },
    printErr: function () {
      var text = joinArguments(arguments);
      log(text);
      console.error(text);
    },
    setStatus: setStatus,
    monitorRunDependencies: function (remaining) {
      totalDependencies = Math.max(totalDependencies, remaining);
      setStatus(remaining
        ? 'Preparing… (' + (totalDependencies - remaining) + '/' + totalDependencies + ')'
        : 'All downloads complete.');
    },
    arguments: baseEngineArguments().concat(urlDrivenArguments()),
    // Download proxy hooks called from src/sys/dl_emscripten.c.
    __etlDLBegin: beginDownload,
    __etlDLGet: downloadField,
    __etlDLReset: resetDownload,
    onAbort: function (what) {
      window.__abort = String(what);
      log('ONABORT: ' + window.__abort);
    },
    onExit: function (code) {
      window.__exit = code;
      log('ONEXIT: ' + code);
    },
  };

  window.Module = Module;

  // Small, stable surface for tooling/tests (avoids sprinkling window globals).
  window.wolfasm = {
    flushHome: flushHome,
    isHomeReady: function () { return homeReady; },
    downloadState: function () { return download; },
    webSocketBridgeUrl: WEBSOCKET_BRIDGE_URL,
    downloadProxyUrl: DOWNLOAD_PROXY_URL,
  };

  setStatus('Downloading…');
  installGlobalErrorHandlers();
  startPersistenceTimers();
  runAutoCommands(resolvePlayerName());
})();
