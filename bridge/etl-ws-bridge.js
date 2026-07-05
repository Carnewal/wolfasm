#!/usr/bin/env node
/*
 * ET: Legacy WASM — WebSocket <-> UDP bridge
 * -----------------------------------------------------------------------------
 * The browser cannot open UDP sockets, but Wolfenstein: Enemy Territory speaks
 * a UDP protocol. This bridge lets the WebAssembly client reach real ET servers
 * (e.g. those listed at https://www.etlegacy.com/servers): the client tunnels
 * each ET datagram over a single WebSocket to this bridge, which relays it as a
 * real UDP packet and sends replies back over the same WebSocket.
 *
 * Wire protocol (binary WebSocket frames), matching src/sys/net_emscripten.c:
 *
 *   client -> bridge   (outgoing datagram)
 *     byte[0..3]  destination IPv4 (network order, a.b.c.d)
 *     byte[4..5]  destination UDP port (big endian)
 *     byte[6..]   ET payload
 *
 *   bridge -> client   (incoming datagram)
 *     byte[0..3]  source IPv4 (network order)
 *     byte[4..5]  source UDP port (big endian)
 *     byte[6..]   ET payload
 *
 * Each WebSocket connection gets its own UDP socket, so multiple destinations
 * (master server + game servers) multiplex over one connection and replies are
 * routed back by source address.
 *
 * Usage:  node etl-ws-bridge.js [--port 9000] [--host 0.0.0.0]
 * Requires: npm install ws   (in this directory)
 */

'use strict';

const dgram = require('dgram');

let WebSocketServer;
try {
	WebSocketServer = require('ws').Server;
} catch (e) {
	console.error("Missing dependency 'ws'. Run:  npm install ws");
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { port: 9000, host: '0.0.0.0', verbose: false };
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === '--port') { opts.port = parseInt(argv[++i], 10); }
		else if (argv[i] === '--host') { opts.host = argv[++i]; }
		else if (argv[i] === '--verbose' || argv[i] === '-v') { opts.verbose = true; }
	}
	return opts;
}

const opts = parseArgs(process.argv);
const wss = new WebSocketServer({ host: opts.host, port: opts.port });

console.log(`[etl-bridge] WebSocket<->UDP bridge listening on ws://${opts.host}:${opts.port}`);

wss.on('connection', (ws, req) => {
	const clientId = (req.socket.remoteAddress || '?') + ':' + (req.socket.remotePort || '?');
	console.log(`[etl-bridge] client connected: ${clientId}`);

	// One UDP socket per WebSocket connection.
	const udp = dgram.createSocket('udp4');

	// Per-connection traffic counters. During a pk3 download the relay moves
	// thousands of packets/sec; a synchronous console.log per packet starves the
	// Node event loop, delaying acks/blocks enough that the server's download
	// window keeps timing out and re-sending (the download would never finish).
	// So we only log control-level events by default and emit a periodic summary.
	let rxCount = 0, txCount = 0, rxBytes = 0, txBytes = 0;
	let summaryTimer = null;
	const scheduleSummary = () => {
		if (summaryTimer || opts.verbose) { return; }
		summaryTimer = setTimeout(() => {
			summaryTimer = null;
			if (rxCount || txCount) {
				console.log(`[etl-bridge] ${clientId}  ws->udp ${txCount} pkt/${txBytes}B   udp->ws ${rxCount} pkt/${rxBytes}B`);
				rxCount = txCount = rxBytes = txBytes = 0;
			}
		}, 1000);
		if (summaryTimer.unref) { summaryTimer.unref(); }
	};

	udp.on('message', (msg, rinfo) => {
		rxCount++; rxBytes += msg.length;
		if (opts.verbose) {
			console.log(`[etl-bridge] UDP <- ${rinfo.address}:${rinfo.port} (${msg.length} bytes) -> ws`);
		} else {
			scheduleSummary();
		}
		// Prepend source addr:port and forward to the browser client.
		const header = Buffer.alloc(6);
		const parts = rinfo.address.split('.');
		header[0] = parseInt(parts[0], 10) & 0xff;
		header[1] = parseInt(parts[1], 10) & 0xff;
		header[2] = parseInt(parts[2], 10) & 0xff;
		header[3] = parseInt(parts[3], 10) & 0xff;
		header.writeUInt16BE(rinfo.port, 4);
		if (ws.readyState === ws.OPEN) {
			ws.send(Buffer.concat([header, msg]));
		}
	});

	udp.on('error', (err) => {
		console.error(`[etl-bridge] udp error for ${clientId}: ${err.message}`);
	});

	ws.on('message', (data) => {
		// data is a Buffer (binary frame). Extract dest addr:port + payload.
		if (!Buffer.isBuffer(data) || data.length < 6) {
			return;
		}
		const ip = `${data[0]}.${data[1]}.${data[2]}.${data[3]}`;
		const port = data.readUInt16BE(4);
		const payload = data.subarray(6);
		txCount++; txBytes += payload.length;
		if (opts.verbose) {
			console.log(`[etl-bridge] ws -> UDP ${ip}:${port} (${payload.length} bytes): ${payload.subarray(0, 24).toString('latin1').replace(/[^ -~]/g, '.')}`);
		} else {
			scheduleSummary();
		}
		udp.send(payload, port, ip, (err) => {
			if (err) {
				console.error(`[etl-bridge] udp send to ${ip}:${port} failed: ${err.message}`);
			}
		});
	});

	ws.on('close', () => {
		console.log(`[etl-bridge] client disconnected: ${clientId}`);
		try { udp.close(); } catch (e) { /* ignore */ }
	});

	ws.on('error', (err) => {
		console.error(`[etl-bridge] ws error for ${clientId}: ${err.message}`);
		try { udp.close(); } catch (e) { /* ignore */ }
	});

	// Bind the UDP socket so it can receive replies.
	udp.bind();
});

wss.on('error', (err) => {
	console.error(`[etl-bridge] server error: ${err.message}`);
	process.exit(1);
});
