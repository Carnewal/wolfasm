#!/usr/bin/env python3
"""Tiny no-cache static server for the ET:Legacy WASM build.

The default http.server lets browsers cache etl.wasm / etl.data, so rebuilds
don't take effect on reload. This server disables caching and sets the correct
MIME type for .wasm.
"""
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
DIRECTORY = sys.argv[2] if len(sys.argv) > 2 else "."


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Cache the large, rarely-changing asset packages; never cache the code
        # (etl.html/js/wasm) so rebuilds always take effect on reload.
        path = self.path.split("?")[0]
        if path.endswith(".data"):
            # Revalidate (If-Modified-Since -> 304 when unchanged = fast; full
            # download when the asset bundle actually changes). Avoids serving a
            # stale bundle after a repackage.
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()


Handler.extensions_map[".wasm"] = "application/wasm"

httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
print(f"no-cache server serving {DIRECTORY} on http://0.0.0.0:{PORT}")
httpd.serve_forever()
