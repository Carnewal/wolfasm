# wolfasm server (Go)

A single Go binary that is the **one endpoint** the browser client talks to. It
serves everything on one port:

| path | purpose |
|------|---------|
| `/` | the static shell + engine (`etl.html`, `etl.js`, `etl.wasm`, `etl*.data`) |
| `/ws` | WebSocket ↔ UDP relay (browsers have no UDP; ET datagrams are relayed to/from real ET servers) |
| `/dl?url=…&origin=…` | HTTP pk3 download proxy for pure servers — fetches server-side (no libcurl / no browser CORS), caches per origin under `dlcache/<origin>/`, streams back |

Because the shell is served from the **same origin** as `/ws` and `/dl`, the
client derives both from `window.location` — so the *same* wasm build runs on
`localhost` and on `play.wolfasm.com` with no rebuild. (`?bridge=ws://host/ws`
overrides if you ever want to point the client at a different relay.)

The page itself is built from `web/shell.html` (baked into `etl.html` at link
time); this server just serves the build output plus the relay and download proxy.

## Build

```bash
# Go 1.23+ (repo installs one under .tools/go)
export GOROOT=$PWD/../.tools/go PATH=$GOROOT/bin:$PATH
go build -o wolfasm-server .
```

It's a static binary — copy it + the built `etl*` assets to the host and run.

## Configure (`.env` or environment)

Copy `.env.example` to `.env`. You only configure the **server**; the client
adapts to whatever host serves it.

| var | default | meaning |
|-----|---------|---------|
| `WOLFASM_ADDR` | `:8080` | listen address |
| `WOLFASM_WEBROOT` | `../etlegacy/build-wasm` | dir with `etl.html` + assets |
| `WOLFASM_CACHE` | `./dlcache` | per-origin pk3 download cache |
| `WOLFASM_TLS_CERT` / `WOLFASM_TLS_KEY` | — | serve HTTPS directly (else terminate TLS at a proxy) |
| `WOLFASM_PUBLIC_HOST` | — | informational, for logs |
| `WOLFASM_VERBOSE` | — | per-packet relay logging |

## Run locally

```bash
./wolfasm-server           # http://localhost:8080/etl.html
```

## Deploy (e.g. play.wolfasm.com)

The client uses `wss://` automatically when the page is served over HTTPS, so the
relay must be reachable over TLS. Two common shapes:

1. **TLS at a reverse proxy / load balancer** (recommended for multiple instances):
   terminate HTTPS at the proxy, forward `/`, `/ws` (WebSocket upgrade) and `/dl`
   to `wolfasm-server` instances on `:8080`. Leave `WOLFASM_TLS_*` unset.
2. **Direct TLS**: set `WOLFASM_TLS_CERT` / `WOLFASM_TLS_KEY` and `WOLFASM_ADDR=:443`.

**Multiple instances**: the binary is stateless apart from its on-disk `dlcache`,
so run as many as you like behind the proxy (each keeps its own cache; identical
otherwise). Point `play.wolfasm.com` at the proxy.
