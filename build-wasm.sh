#!/usr/bin/env bash
# Linux build driver for the ET:Legacy WebAssembly client (emsdk + ninja).
# Replaces the Windows-only emscripten_configure.ps1 / emscripten_build.ps1.
#
#   ./build-wasm.sh configure     # patch emsdk + emcmake cmake -> etlegacy/build-wasm
#   ./build-wasm.sh               # ninja build (all targets)
#   ./build-wasm.sh etl           # build just one target
#   ./build-wasm.sh assets        # package etmain assets -> etl.data / etl_data.js
#   ./build-wasm.sh patch-emsdk   # (idempotently) apply port/emsdk-patches/* to emsdk
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Respect an existing $EMSDK (e.g. the emscripten/emsdk Docker image sets it to
# /emsdk); otherwise use the emsdk installed at the repo root.
EMSDK="${EMSDK:-$ROOT/emsdk}"
SRC="$ROOT/etlegacy"
BUILD="$SRC/build-wasm"
EMDIR="$EMSDK/upstream/emscripten"   # emscripten source root (patch target)

# emsdk + ninja on PATH (emsdk_env.sh only when present; the Docker image already
# has emcc on PATH; .tools/bin holds a local ninja for the non-Docker setup).
export EMSDK_QUIET=1
# shellcheck disable=SC1091
[ -f "$EMSDK/emsdk_env.sh" ] && source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
export PATH="$ROOT/.tools/bin:$ROOT/.tools/go/bin:$PATH"

# Apply our emsdk source patches idempotently. These fix Emscripten itself (not
# the engine), so they can't live in port/patches/ (that's the etlegacy tree).
# Notably libglemu-addfunction-sig: without it a MAIN_MODULE build aborts at boot
# with "Missing signature argument to addFunction" (GL emulation wrappers lose
# their .sig). A fresh `emsdk install` resets these files, so re-run after that.
patch_emsdk() {
  local p
  for p in "$ROOT"/port/emsdk-patches/*.patch; do
    [ -e "$p" ] || continue
    if patch -R -p1 -s -f --dry-run -d "$EMDIR" < "$p" >/dev/null 2>&1; then
      echo "emsdk patch already applied: $(basename "$p")"
    elif patch -p1 -s -f --dry-run -d "$EMDIR" < "$p" >/dev/null 2>&1; then
      patch -p1 -s -f -d "$EMDIR" < "$p" && echo "applied emsdk patch: $(basename "$p")"
    else
      echo "WARNING: emsdk patch does not apply cleanly: $(basename "$p")" >&2
    fi
  done
}

cmd="${1:-build}"

case "$cmd" in
patch-emsdk)
  patch_emsdk
  ;;
download-assets)
  # Fetch the freely-redistributable game data: the retail etmain paks (ET is
  # freeware) and the ET:Legacy 2.84.0 mod pak. Skips files already present.
  mkdir -p "$ROOT/assets/etmain" "$ROOT/assets/legacy"
  for f in pak0 pak1 pak2 mp_bin; do
    [ -s "$ROOT/assets/etmain/$f.pk3" ] || curl -fL --retry 3 -o "$ROOT/assets/etmain/$f.pk3" "https://mirror.etlegacy.com/etmain/$f.pk3"
  done
  if [ ! -s "$ROOT/assets/legacy/legacy_v2.84.0.pk3" ]; then
    tmp="$(mktemp -d)"
    curl -fL --retry 3 -o "$tmp/etl.tgz" "https://www.etlegacy.com/download/file/715"   # etlegacy-v2.84.0-x86_64.tar.gz
    tar -xzf "$tmp/etl.tgz" -C "$tmp"
    cp "$tmp"/etlegacy-v2.84.0*/legacy/legacy_v2.84.0.pk3 "$ROOT/assets/legacy/"
    rm -rf "$tmp"
  fi
  echo "assets ready: $(du -sh "$ROOT/assets" | cut -f1)"
  ;;
configure)
  patch_emsdk
  emcmake cmake -S "$SRC" -B "$BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Debug \
    -DBUILD_SERVER=OFF -DBUILD_CLIENT=ON \
    -DBUILD_MOD=ON -DBUILD_CLIENT_MOD=ON -DBUILD_SERVER_MOD=ON -DBUILD_MOD_PK3=OFF \
    -DFEATURE_LUA=OFF -DFEATURE_OMNIBOT=OFF \
    -DBUNDLED_LIBS=ON \
    -DRENDERER_DYNAMIC=OFF \
    -DFEATURE_RENDERER1=OFF -DFEATURE_RENDERER2=OFF -DFEATURE_RENDERER_GLES=ON -DFEATURE_RENDERER_VULKAN=OFF \
    -DFEATURE_CURL=OFF -DFEATURE_SSL=OFF -DFEATURE_AUTH=OFF -DFEATURE_IPV6=OFF \
    -DFEATURE_OGG_VORBIS=OFF -DFEATURE_THEORA=OFF -DFEATURE_OPENAL=OFF \
    -DFEATURE_FREETYPE=OFF -DFEATURE_PNG=OFF -DFEATURE_DBMS=ON \
    -DFEATURE_AUTOUPDATE=OFF -DFEATURE_IRC_CLIENT=OFF \
    -DCROSS_COMPILE32=OFF -DENABLE_MULTI_BUILD=OFF \
    -DINSTALL_EXTRA=OFF
  ;;
assets)
  # Two FS bundles preloaded before main() (see web/shell.html):
  #   etl_data.js       assets/ (etmain + legacy pk3s) -> /etl
  #   etl_mods_data.js  the built cgame/ui/qagame SIDE_MODULE .wasm -> /etl/legacy
  FP="$EMSDK/upstream/emscripten/tools/file_packager.py"
  ( cd "$BUILD" && python3 "$FP" etl.data --preload "$ROOT/assets@/etl" --js-output=etl_data.js )
  rm -rf "$BUILD/modstage"; mkdir -p "$BUILD/modstage/legacy"
  cp "$BUILD"/legacy/*.wasm "$BUILD/modstage/legacy/"
  ( cd "$BUILD" && python3 "$FP" etl_mods.data --preload "modstage@/etl" --js-output=etl_mods_data.js )
  ;;
*)
  # Editing web/shell.html does not retrigger a link (ninja doesn't track
  # --shell-file); drop the html so the shell change takes effect.
  rm -f "$BUILD/etl.html"
  if [ "$cmd" = "build" ]; then
    ninja -C "$BUILD" -j "$(nproc)"
  else
    ninja -C "$BUILD" -j "$(nproc)" "$cmd"
  fi
  # shell.js is a sibling static file (not baked into etl.html); the server
  # serves it same-origin, so keep the built copy in sync with the source.
  cp "$ROOT/web/shell.js" "$BUILD/shell.js"
  ;;
esac
