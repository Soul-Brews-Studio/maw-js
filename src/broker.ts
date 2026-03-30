#!/usr/bin/env bun
/**
 * Standalone MQTT broker — runs as a separate PM2 process.
 * TCP on :1883 for agents/peers, WebSocket on :9001 for browsers.
 * Prefer system mosquitto; this is the Aedes fallback.
 */

import { Aedes } from "aedes";
import { createServer } from "net";
import { WebSocketServer } from "ws";
import { Duplex } from "stream";
import { readFileSync } from "fs";
import { join } from "path";
import { createHmac, timingSafeEqual } from "crypto";

// Read config directly (no maw imports — keeps broker standalone)
const CONFIG_PATH = join(process.env.HOME || "/home/nat", ".config/maw/maw.config.json");
let config: any = {};
try { config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}

const MQTT_PORT = config.mqtt?.port || 1883;
const WS_PORT = config.mqtt?.wsPort || 9883;
const TOKEN = config.federationToken || "";

// --- Aedes broker ---

const aedes = await Aedes.createBroker();

// HMAC auth (same pattern as federation-auth.ts)
if (TOKEN) {
  aedes.authenticate = (_client, username, password, callback) => {
    if (!password) return callback(new Error("password required"), false);
    const pw = password.toString();
    const parts = pw.split(":");
    if (parts.length !== 2) return callback(new Error("bad format"), false);
    const [sig, tsStr] = parts;
    const ts = parseInt(tsStr, 10);
    if (isNaN(ts)) return callback(new Error("bad timestamp"), false);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 300) return callback(new Error("expired"), false);
    const expected = createHmac("sha256", TOKEN)
      .update(`MQTT:${username || "maw"}:${ts}`)
      .digest("hex");
    try {
      const ok = timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
      callback(null, ok);
    } catch {
      callback(new Error("auth failed"), false);
    }
  };
}

// --- TCP listener (:1883) ---

const tcpServer = createServer(aedes.handle);
tcpServer.listen(MQTT_PORT, "0.0.0.0", () => {
  console.log(`[broker] MQTT TCP on :${MQTT_PORT}`);
});
tcpServer.on("error", (err: any) => {
  console.error(`[broker] TCP :${MQTT_PORT} failed: ${err.message}`);
});

// --- WebSocket listener (:9001) for browsers ---

const wss = new WebSocketServer({ port: WS_PORT, host: "0.0.0.0" });
wss.on("error", (err: any) => console.error(`[broker] WS :${WS_PORT} failed: ${err.message}`));
wss.on("connection", (ws) => {
  const duplex = new Duplex({
    read() {},
    write(chunk, _encoding, cb) {
      try { ws.send(chunk); cb(); } catch (e: any) { cb(e); }
    },
    final(cb) { ws.close(); cb(); },
  });
  ws.on("message", (data) => duplex.push(Buffer.isBuffer(data) ? data : Buffer.from(data as any)));
  ws.on("close", () => { duplex.push(null); duplex.destroy(); });
  ws.on("error", () => duplex.destroy());
  aedes.handle(duplex);
});
wss.on("listening", () => {
  console.log(`[broker] MQTT-WS on :${WS_PORT}`);
});

// --- Logging ---

aedes.on("client", (client) => console.log(`[broker] + ${client.id}`));
aedes.on("clientDisconnect", (client) => console.log(`[broker] - ${client.id}`));

// --- Graceful shutdown ---

process.on("SIGTERM", () => { aedes.close(); tcpServer.close(); wss.close(); process.exit(0); });
process.on("SIGINT", () => { aedes.close(); tcpServer.close(); wss.close(); process.exit(0); });

console.log(`[broker] maw MQTT broker (aedes) started`);
