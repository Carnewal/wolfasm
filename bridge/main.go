// ET: Legacy WASM — unified server (Go)
//
// One clean endpoint/port serves everything the browser client needs:
//
//   /            static shell + engine (etl.html/js/wasm/data, asset bundles)
//   /ws          WebSocket <-> UDP relay (browsers have no UDP; we relay ET
//                datagrams to/from real ET servers)
//   /dl          HTTP download proxy for pure-server pk3s: fetches server-side
//                (no libcurl / no browser CORS), caches per origin, streams back
//
// Because the shell is served from the same origin as /ws and /dl, the client
// derives both from window.location — so the same build works on localhost and
// on any deployed host (e.g. play.wolfasm.com) with no rebuild. Configuration is
// via environment (optionally a .env file); see .env.example.
//
// Wire protocol on /ws (binary frames), matching src/sys/net_emscripten.c:
//   client->server: [4B dst IPv4][2B dst port BE][payload]
//   server->client: [4B src IPv4][2B src port BE][payload]
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type config struct {
	addr       string // listen address, e.g. ":8080"
	webRoot    string // directory with etl.html + assets
	cacheDir   string // per-origin download cache
	tlsCert    string // optional: enable HTTPS
	tlsKey     string
	publicHost string // optional: informational (e.g. play.wolfasm.com)
	verbose    bool
}

func loadConfig() config {
	loadDotEnv(".env")
	c := config{
		addr:       env("WOLFASM_ADDR", ":8080"),
		webRoot:    env("WOLFASM_WEBROOT", "../etlegacy/build-wasm"),
		cacheDir:   env("WOLFASM_CACHE", "./dlcache"),
		tlsCert:    env("WOLFASM_TLS_CERT", ""),
		tlsKey:     env("WOLFASM_TLS_KEY", ""),
		publicHost: env("WOLFASM_PUBLIC_HOST", ""),
		verbose:    env("WOLFASM_VERBOSE", "") != "",
	}
	return c
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

// loadDotEnv reads simple KEY=VALUE lines from path (if it exists) into the
// environment without overriding already-set variables.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		k := strings.TrimSpace(line[:eq])
		v := strings.Trim(strings.TrimSpace(line[eq+1:]), `"'`)
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
}

var cfg config

//-----------------------------------------------------------------------------
// /config.js : runtime config injected into the shell before shell.js runs.
//
// The browser can't DNS-resolve the ET master/MOTD hostnames to usable UDP peers
// (Emscripten hands back virtual IPs), so we resolve them here at startup and
// hand the shell the concrete addresses. com_masterServer/com_motdServer are
// CVAR_INIT (settable only at engine init), so injecting synchronously before
// shell.js builds the engine arguments is required.
//-----------------------------------------------------------------------------

const (
	masterHost       = "master.etlegacy.com"
	masterPort       = 27950
	motdHost         = "motd.etlegacy.com"
	motdPort         = 27951
	masterFallbackIP = "104.248.140.165" // last-known IP if DNS fails
)

var runtimeConfig struct {
	MasterServer string `json:"masterServer"`
	MotdServer   string `json:"motdServer"`
}

func resolveServerAddr(host string, port int, fallbackIP string) string {
	ip := fallbackIP
	if addrs, err := net.LookupHost(host); err == nil && len(addrs) > 0 {
		for _, candidate := range addrs {
			if parsed := net.ParseIP(candidate); parsed != nil && parsed.To4() != nil {
				ip = candidate
				break
			}
		}
	} else if err != nil {
		log.Printf("[config] resolve %s failed (%v); using fallback %s", host, err, fallbackIP)
	}
	return fmt.Sprintf("%s:%d", ip, port)
}

func resolveMasterServers() {
	runtimeConfig.MasterServer = resolveServerAddr(masterHost, masterPort, masterFallbackIP)
	runtimeConfig.MotdServer = resolveServerAddr(motdHost, motdPort, masterFallbackIP)
	log.Printf("[config] master=%s  motd=%s", runtimeConfig.MasterServer, runtimeConfig.MotdServer)
}

func configHandler(w http.ResponseWriter, r *http.Request) {
	payload, _ := json.Marshal(runtimeConfig)
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	fmt.Fprintf(w, "window.WOLFASM_CONFIG=%s;\n", payload)
}

//-----------------------------------------------------------------------------
// /ws : WebSocket <-> UDP relay
//-----------------------------------------------------------------------------

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	Subprotocols:    []string{"binary"},
	CheckOrigin:     func(r *http.Request) bool { return true }, // same-origin in practice; allow all
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close()

	udp, err := net.ListenUDP("udp4", nil)
	if err != nil {
		log.Printf("[ws] udp socket: %v", err)
		return
	}
	defer udp.Close()

	client := r.RemoteAddr
	log.Printf("[ws] client connected: %s", client)
	defer log.Printf("[ws] client disconnected: %s", client)

	// UDP -> WS (single writer of ws)
	go func() {
		buf := make([]byte, 65535)
		for {
			n, src, err := udp.ReadFromUDP(buf)
			if err != nil {
				return
			}
			ip4 := src.IP.To4()
			if ip4 == nil {
				continue
			}
			frame := make([]byte, 6+n)
			copy(frame[0:4], ip4)
			frame[4] = byte(src.Port >> 8)
			frame[5] = byte(src.Port)
			copy(frame[6:], buf[:n])
			if err := ws.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				return
			}
			if cfg.verbose {
				log.Printf("[ws] udp<-%s:%d %dB -> client", src.IP, src.Port, n)
			}
		}
	}()

	// WS -> UDP
	for {
		mt, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.BinaryMessage || len(data) < 6 {
			continue
		}
		dst := &net.UDPAddr{
			IP:   net.IPv4(data[0], data[1], data[2], data[3]),
			Port: int(data[4])<<8 | int(data[5]),
		}
		if _, err := udp.WriteToUDP(data[6:], dst); err != nil {
			if cfg.verbose {
				log.Printf("[ws] udp send %s failed: %v", dst, err)
			}
		}
	}
}

//-----------------------------------------------------------------------------
// /dl : HTTP download proxy with per-origin cache
//-----------------------------------------------------------------------------

func sanitize(s string) string {
	if s == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' ||
			r == '.' || r == '_' || r == '-' || r == ':' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return b.String()
}

var dlClient = &http.Client{Timeout: 5 * time.Minute} // follows redirects by default

func dlHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	q := r.URL.Query()
	rawURL := q.Get("url")
	if rawURL == "" {
		http.Error(w, "missing url", http.StatusBadRequest)
		return
	}
	origin := sanitize(q.Get("origin"))
	base := sanitize(filepath.Base(rawURL))
	if i := strings.IndexByte(base, '?'); i >= 0 {
		base = base[:i]
	}
	dir := filepath.Join(cfg.cacheDir, origin)
	dest := filepath.Join(dir, base)

	if fi, err := os.Stat(dest); err == nil && fi.Size() > 0 {
		log.Printf("[dl] CACHE HIT %s/%s", origin, base)
		http.ServeFile(w, r, dest)
		return
	}

	log.Printf("[dl] FETCH %s -> %s/%s", rawURL, origin, base)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, "cache mkdir failed", http.StatusInternalServerError)
		return
	}
	resp, err := dlClient.Get(rawURL)
	if err != nil {
		log.Printf("[dl] FAILED %s: %v", rawURL, err)
		http.Error(w, "fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("[dl] FAILED %s: HTTP %d", rawURL, resp.StatusCode)
		http.Error(w, "upstream HTTP "+strconv.Itoa(resp.StatusCode), http.StatusBadGateway)
		return
	}
	tmp := dest + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		http.Error(w, "cache write failed", http.StatusInternalServerError)
		return
	}
	n, err := io.Copy(f, resp.Body)
	f.Close()
	if err != nil {
		os.Remove(tmp)
		http.Error(w, "download interrupted", http.StatusBadGateway)
		return
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		http.Error(w, "cache finalize failed", http.StatusInternalServerError)
		return
	}
	log.Printf("[dl] OK %s/%s (%d B)", origin, base, n)
	http.ServeFile(w, r, dest)
}

//-----------------------------------------------------------------------------
// / : static shell + engine + assets
//-----------------------------------------------------------------------------

func staticHandler(root string) http.Handler {
	fs := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Land straight on the game: "/" serves the shell.
		if r.URL.Path == "/" {
			r.URL.Path = "/etl.html"
		}
		path := r.URL.Path
		// Cache the big, rarely-changing asset bundles (revalidate); never cache
		// the code (etl.html/js/wasm) so rebuilds always take effect on reload.
		if strings.HasSuffix(path, ".data") {
			w.Header().Set("Cache-Control", "no-cache")
		} else {
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		}
		fs.ServeHTTP(w, r)
	})
}

func main() {
	cfg = loadConfig()
	_ = mime.AddExtensionType(".wasm", "application/wasm")

	resolveMasterServers()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/dl", dlHandler)
	mux.HandleFunc("/config.js", configHandler)
	mux.Handle("/", staticHandler(cfg.webRoot))

	srv := &http.Server{Addr: cfg.addr, Handler: mux}

	scheme := "http"
	if cfg.tlsCert != "" && cfg.tlsKey != "" {
		scheme = "https"
	}
	log.Printf("[wolfasm] serving shell + /ws + /dl on %s://%s%s  (webroot=%s cache=%s public=%s)",
		scheme, hostOr(cfg.publicHost, "0.0.0.0"), cfg.addr, cfg.webRoot, cfg.cacheDir, orNone(cfg.publicHost))

	// graceful-ish: nothing stateful beyond the disk cache
	_ = context.Background()
	var err error
	if scheme == "https" {
		err = srv.ListenAndServeTLS(cfg.tlsCert, cfg.tlsKey)
	} else {
		err = srv.ListenAndServe()
	}
	if err != nil {
		log.Fatalf("[wolfasm] server error: %v", err)
	}
}

func hostOr(h, def string) string {
	if h != "" {
		return h
	}
	return def
}
func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}
