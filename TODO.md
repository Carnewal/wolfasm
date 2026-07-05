# TODO / Handoff — ET: Legacy WebAssembly port

Status snapshot for the next agent. Read this top-to-bottom before touching code.

## What this project is

A WebAssembly (browser) port of **ET: Legacy** (open-source Wolfenstein: Enemy
Territory engine, https://github.com/etlegacy/etlegacy), plus a **WebSocket↔UDP
bridge** so the browser client can talk to real live ET servers (browsers have no
UDP). Goal: run the game in the browser and play on live servers.

Layout (repo root `wolfasm/`):
- `etlegacy/` — engine source with all the Emscripten port changes (guarded by
  `__EMSCRIPTEN__` / `EMSCRIPTEN`). This is the code you edit.
- `bridge/etl-ws-bridge.js` — Node WebSocket↔UDP relay.
- `web/shell.html` — Emscripten HTML shell (canvas + loader + startup args).
- `web/serve.py` — dev HTTP server (threaded, right MIME/cache headers).
- **Not in git** (you must supply locally): `emsdk/` (Emscripten SDK),
  `assets/` + `assets_mods/` (retail + mod pk3s — copyrighted, keep them out of
  git), `etlegacy/build-wasm/` (build output + `etl.data` asset bundle + any
  downloaded server paks). See "Environment setup" below.

## ⚠️ CURRENT BLOCKER (was mid-investigation) — black 3D world

**Symptom:** In-game, the 2D HUD renders fine (compass, ammo, warmup text,
limbo command-map, menus), and game logic works (collision, weapon fire,
movement all update state correctly), **but the 3D world view itself is black.**
We had been "verifying" via HUD/state readouts and screenshots of 2D screens, so
this was masked until noticed at first-person spawn.

**Strong hypothesis:** Emscripten's `LEGACY_GL_EMULATION` prints
`"DrawElements doesn't actually prepareClientAttributes properly."` during load.
The ET GLES renderer draws **world geometry** with `glDrawElements` + client-side
vertex arrays (`glVertexPointer`/`glTexCoordPointer`/`glColorPointer`). The 2D
HUD path renders (different code path), but 3D world surfaces via
`glDrawElements`+client arrays don't → black scene.

**Next steps to confirm/fix (in order):**
1. Reproduce: get a first-person 3D view. Load a local map with no warmup so you
   spawn straight into first person:
   `etl.html?exec=sv_pure 0;set bot_enable 0;set g_doWarmup 0;devmap oasis`
   then (via the JS command hook, see below) `team r; class s 3 3`, wait for the
   spawn wave, press ESC (synthetic key) to close limbo. Confirm black 3D.
2. Confirm the cause: check the console/`window.__etlog` for the
   `prepareClientAttributes` warning and any `glError`. Sample the framebuffer
   with `gl.readPixels` (or `preview_screenshot`) — expect ~all black except HUD.
3. Fix options, roughly increasing effort:
   - Patch Emscripten's GL emulation (`emsdk/upstream/emscripten/src/lib/libglemu.js`)
     to actually set up client vertex attributes for `glDrawElements`. We already
     patched this file once (added `.sig` to reassigned GL wrappers for
     `addFunction` — see that change for the pattern). The client-array path is
     the likely gap.
   - Or make the renderer avoid client-side arrays: upload world geometry to
     real GL buffers (VBOs) and use `glDrawElements` with bound buffers, which
     Emscripten GL handles correctly. This is renderer surgery in
     `etlegacy/src/rendererGLES/` (tess/backend `RB_*`, `R_DrawElements`).
   - Or evaluate switching to a GLES2/shader path if one exists.
4. **Watch for regressions:** the collision fix (below) restores `cm.leafs` at
   trace time; make sure any renderer change doesn't reintroduce the heap
   corruption (the corrupt data was drawVert floats — a renderer/GL pointer bug —
   so the two may be related; see "Collision" note).

## What already works (do not re-do)

- **Toolchain + build**: Emscripten cross-compile of the engine to wasm; mods
  (cgame/ui/qagame) built as `SIDE_MODULE` `.wasm`, `dlopen`'d by the
  `MAIN_MODULE` engine. `emscripten_configure.ps1` then `emscripten_build.ps1`.
- **Boots & renders 2D**: SDL2 + WebGL, menus, profile creation, server browser
  (populated from the real master server via the bridge).
- **Networking**: `src/sys/net_emscripten.c` tunnels the UDP netchan over a
  WebSocket to `bridge/etl-ws-bridge.js`. Master query, challenge→connect→
  gamestate handshake, live snapshots all work.
- **UDP pk3 download over the bridge** (fixed): `cl_wwwDownload 0` forces the
  windowed UDP download, which now completes over the relay (was stalling). Note
  it's slow (~25 KB/s, server-rate-capped). For big paks, prefer the fast
  side-load trick below.
- **Collision** (root-caused + worked around): the "OOB / fall-through-the-world"
  bug is a **stray write that overwrites `cm.leafs` with drawVert float data
  during client init** (renderer world load). Its symptoms cascaded into a fatal
  `CM_AreasConnected: area >= cm.numAreas` server crash. Fixes in place:
  - `src/qcommon/cm_test.c`: `CM_AreasConnected` / `CM_AdjustAreaPortalState`
    made non-fatal under `__EMSCRIPTEN__` (return instead of `Com_Error`).
  - `src/qcommon/cm_load.c` + `cm_trace.c` + `cm_local.h`:
    `CM_EMS_BackupLeafs()` snapshots `cm.leafs` right after load;
    `CM_EMS_RestoreLeafsIfCorrupt()` (canary-gated) restores it at the top of
    `CM_Trace` / `CM_PointContents`. This makes physical collision work (verified:
    player stands on ground, `viewpos` Z stable ~-174 on oasis instead of
    freefalling to Z=-millions).
  - **The real root cause (the stray writer) is still unfixed** — the
    backup/restore is a workaround. It may share a cause with the black-3D
    renderer bug (both involve drawVert/GL client arrays). Fixing the renderer
    might make the corruption disappear; if so, the workaround can be removed.

## Driving the game programmatically (important tooling we added)

The browser has no way to reach the command buffer of a running instance, and
pointer-lock can't be synthesized. Two mechanisms were added:

1. **JS→engine command hook** — `ETL_ExecCommand` (in `src/qcommon/common.c`,
   `EMSCRIPTEN_KEEPALIVE`). From the page:
   `Module.ccall('ETL_ExecCommand','null',['string'],['<console command>'])`.
   Use it for `connect`, `team r`, `class s 3 3`, `+forward`/`-forward`,
   `+moveup` (jump), `+attack` (fire), `viewpos`, etc. Runs on the next
   `Cbuf_Execute`. `HEAP32/HEAPF32/HEAPU8` are also exported for memory
   inspection (see `EXPORTED_RUNTIME_METHODS` in `cmake/ETLEmscripten.cmake`).
2. **Synthetic keyboard events DO reach SDL2** — dispatch
   `new KeyboardEvent('keydown'/'keyup', {code,key,keyCode,which,bubbles:true})`
   to the canvas/document. Verified: opened the console with a synthetic
   backquote, closed limbo with synthetic Escape. (Synthetic MOUSE / pointer-lock
   does **not** work — drive turning/looking with `+left`/`+right`/`+lookup`/
   `+lookdown` via the command hook instead.)

Verified in-game actions (local devmap, after the collision fix): **fire**
(ammo 30→24), **move** (compass + `viewpos` change), **look**. Once 3D renders,
this is enough to fully demonstrate walk/jump/fire.

## Live-server / pure-server notes

- **Fast pak side-load** (much faster than UDP download): the browser can't
  fetch a server's HTTP mirror cross-origin (CORS), so download the required
  pk3s **server-side** with `curl` into `etlegacy/build-wasm/dlpaks/{legacy,etmain}/`
  (served same-origin), then inject into the running client's FS and connect
  without a page reload:
  ```js
  // per pak: fetch same-origin, write to /etlhome/{legacy|etmain}/<name>.pk3
  const b = new Uint8Array(await (await fetch('/dlpaks/legacy/z_tot16.pk3')).arrayBuffer());
  Module.FS.writeFile('/etlhome/legacy/z_tot16.pk3', b);
  // then: Module.ccall('ETL_ExecCommand','null',['string'],['connect <ip:port>'])
  ```
  A `connect` triggers `FS_ConditionalRestart` which re-scans and picks up the
  injected paks. (Page reload loses MEMFS/IDBFS-injected paks reliably, so inject
  then connect via the hook — no reload.)
- **Pure-server fix** (in place): `src/qcommon/files.c`
  `FS_ReferencedPakPureChecksums` — the browser client loads cgame/ui as loose
  wasm side-modules, so no pak was flagged `FS_CGAME_REF`/`FS_UI_REF` and the
  server rejected the leading `@` in the `cp` command
  ("Unpure client detected. Invalid .PK3 files referenced!"). We now
  `FS_EMS_MarkModRef(...)` the real mod pak (contains `cgame.mp.x86_64.so` etc.)
  so the client reports the cgame/ui checksums the server expects. This got us
  **past** the pure check on a live server.
- **Heap size bumped to 2 GB** (`INITIAL_MEMORY=2147483648` in
  `cmake/ETLEmscripten.cmake`) so all of a server's custom paks + gameplay fit.
  Fixed size is fine — the WebGL "resizable ArrayBuffer" constraint is about
  `ALLOW_MEMORY_GROWTH`, not absolute size. Do NOT enable memory growth.

### The specific server the user asked about: `109.230.236.111:27960` (hirntot)

We got all the way through: connect → forced UDP/side-loaded its 5+ map paks →
**passed the pure check** → loaded cgame → then the server disconnected with
**"incompatible cgame"**. This is a **custom server-side check** (its Lua
`G_LuaHook_ClientConnect` / custom `ht260520_legacy` build), NOT a stock check —
our cgame passed the stock `CS_GAME_VERSION` match. **This server is effectively
un-joinable with a stock wasm cgame** (anti-tamper rejects non-matching clients).
To demonstrate the full remote gameplay flow, use a **stock ET: Legacy 2.84.x
server without custom anti-cheat** (our cgame is compatible there), or a local
`devmap`.

## Reconstructing the engine source (the port is shipped as a patch)

This repo does **not** contain the full ET: Legacy tree (it's a large fork with
submodules + signing keystores). Our port lives in `port/etlegacy-port.patch`
(31 files: 26 modified + 5 new), against ET: Legacy commit **`b05dffd61`**
(`v2.84.0-18-gb05dffd`). To reconstruct a buildable tree:

```bash
git clone https://github.com/etlegacy/etlegacy.git
cd etlegacy
git checkout b05dffd61
git submodule update --init --recursive     # if libs/ come up empty
git apply ../port/etlegacy-port.patch        # applies ALL our port changes
```

The patch includes the two `emscripten_*.ps1` build scripts and the new
`cmake/ETLEmscripten.cmake`, `src/sys/net_emscripten.c`,
`src/sys/emscripten_gl_shim.c`. After applying, follow "Environment setup".

## Environment setup (for a fresh clone)

Not in git — obtain locally:
1. `emsdk/` — install Emscripten (6.x) at repo root, or point the scripts at your
   emsdk. The `.ps1` scripts source `emsdk/emsdk_env.ps1`.
2. `assets/etmain/*.pk3` — retail ET paks from https://mirror.etlegacy.com/etmain/
   (+ legacy mod assets). Then package into the asset bundle:
   ```powershell
   python emsdk/upstream/emscripten/tools/file_packager.py `
     build-wasm/etl.data --preload assets@/etl --js-output=build-wasm/etl_data.js
   ```
   (and similarly `etl_mods.data` for the wasm mods + `ui/version_generated.h`).
3. Build: from `etlegacy/`, `./emscripten_configure.ps1` then
   `./emscripten_build.ps1` (or `./emscripten_build.ps1 etl` for just the engine).
   Editing `web/shell.html` does NOT retrigger a link — delete
   `build-wasm/etl.html` before rebuilding, or the shell won't update.
4. Run: `python web/serve.py 8080 etlegacy/build-wasm`, open
   `http://localhost:8080/etl.html`. For live servers:
   `cd bridge && npm install ws && node etl-ws-bridge.js --port 9000`.

Windows / PowerShell: each `.ps1` rebuilds `$env:Path` from the registry and
sources `emsdk_env.ps1` with `$env:EMSDK_QUIET=1`.

## Debugging workflow that worked

- The dev preview (`mcp__Claude_Preview__*`) can run the server and `eval` JS in
  the page. `console.log`/`Com_Printf` output is mirrored to `window.__etlog`
  (see `web/shell.html` `print`/`printErr`) — read it via `preview_eval`.
- `preview_screenshot` for visuals; but screenshots can time out during
  continuous rendering — prefer reading `__etlog`, `viewpos`, and `readPixels`.
- Add temporary `Com_Printf("TAG ...")` diagnostics (they land in `__etlog`).
  Several `CMDIAG`/`CMDUMP`/`PURECHK` diagnostics were used and then removed;
  the pattern is in git history / earlier versions of `cm_trace.c`.

## Files changed for the port (grep `__EMSCRIPTEN__` / `EMSCRIPTEN` for all)

Key ones: `cmake/ETLEmscripten.cmake`, `cmake/ETLBuild{Client,Mod}.cmake`,
`src/sys/{net_emscripten.c,emscripten_gl_shim.c,sys_main.c}`,
`src/qcommon/{net_ip.c,common.c,files.c,cm_load.c,cm_trace.c,cm_test.c,cm_local.h,
vm.c,q_platform.h,q_shared.h}`,
`src/client/{cl_main.c,cl_parse.c,cl_scrn.c,cl_ui.c}`,
`src/{cgame,ui,game}/*_main.c` (17-arg `vmMain`), `web/shell.html`,
`bridge/etl-ws-bridge.js`.

## Priority order for next session

1. **Fix the black 3D world** (the blocker) — see the section above.
2. Once 3D renders: demonstrate full flow on a stock legacy server or local
   devmap — spawn, walk, jump, fire (tooling is ready).
3. (Optional) Find the real stray-writer root cause; if it's the renderer
   client-array bug, fixing #1 may remove the need for the collision
   backup/restore workaround.
4. (Optional) Implement HTTP `Com_BeginWebDownload` via a `serve.py` proxy +
   Emscripten fetch so pure servers' `wwwdl` works without the manual side-load.
