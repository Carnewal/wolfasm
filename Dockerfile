# wolfasm — end-to-end build & serve of the ET: Legacy WebAssembly client.
#
# Three stages:
#   1. wasm     — emsdk + ninja: clone ET:Legacy v2.84.0, apply the port patches
#                 (+ emsdk patch), build the wasm client, download game data and
#                 package the asset bundles, then assemble a clean webroot.
#   2. goserver — build the unified Go server (serves shell + /ws relay + /dl proxy).
#   3. runtime  — a small image with just the server binary + webroot.
#
# Build:  docker build -t wolfasm .
# Run:    docker run -p 8080:8080 wolfasm        # http://localhost:8080/
#
# The game data (retail etmain paks + the ET:Legacy 2.84.0 mod pak) is downloaded
# during the build, so the image is self-contained. To keep it out (and mount it
# at runtime instead) set --build-arg DOWNLOAD_ASSETS=0 and mount a /app/webroot.

#-----------------------------------------------------------------------------
# 1. WebAssembly client + assets
#-----------------------------------------------------------------------------
# Emscripten version is pinned via the base image tag. The emsdk patch in
# port/emsdk-patches/ is version-sensitive; bump both together if you change it.
ARG EMSDK_TAG=latest
FROM emscripten/emsdk:${EMSDK_TAG} AS wasm

ARG DOWNLOAD_ASSETS=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ninja-build cmake curl ca-certificates patch \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /wolfasm
COPY build-wasm.sh ./
COPY port/ ./port/
COPY web/ ./web/

# ET:Legacy engine source at the exact release the port targets, + submodules.
RUN git clone --branch v2.84.0 --depth 1 --recurse-submodules --shallow-submodules \
        https://github.com/etlegacy/etlegacy.git etlegacy

# Apply the port (11 split patches). The emsdk patch is applied by
# `build-wasm.sh configure` (patch_emsdk) against the image's /emsdk.
RUN cd etlegacy && for p in ../port/patches/[0-9]*.patch; do echo "applying $(basename "$p")"; git apply "$p"; done

# Build: configure (patch emsdk + emcmake cmake) -> ninja -> assets. EMSDK is set
# by the base image (/emsdk); build-wasm.sh honours it.
RUN ./build-wasm.sh configure && ./build-wasm.sh
RUN if [ "$DOWNLOAD_ASSETS" = "1" ]; then ./build-wasm.sh download-assets && ./build-wasm.sh assets; fi

# Assemble a clean webroot with only what the browser fetches (the loose mod
# .wasm live inside etl_mods.data, so they are not copied).
RUN mkdir -p /webroot && cd etlegacy/build-wasm && \
    cp etl.html etl.js etl.wasm shell.js /webroot/ && \
    if [ "$DOWNLOAD_ASSETS" = "1" ]; then cp etl.data etl_data.js etl_mods.data etl_mods_data.js /webroot/; fi

#-----------------------------------------------------------------------------
# 2. Go server
#-----------------------------------------------------------------------------
FROM golang:1.23-bookworm AS goserver
WORKDIR /src
COPY bridge/go.mod bridge/go.sum ./
RUN go mod download
COPY bridge/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /wolfasm-server .

#-----------------------------------------------------------------------------
# 3. Runtime
#-----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=goserver /wolfasm-server /app/wolfasm-server
COPY --from=wasm /webroot /app/webroot

ENV WOLFASM_ADDR=:8080 \
    WOLFASM_WEBROOT=/app/webroot \
    WOLFASM_CACHE=/app/dlcache
EXPOSE 8080
VOLUME ["/app/dlcache"]

ENTRYPOINT ["/app/wolfasm-server"]
