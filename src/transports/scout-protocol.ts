/**
 * Scout/Hello discovery protocol — message types and utilities.
 *
 * Inspired by Eclipse Zenoh's scouting protocol:
 *   Scout (multicast) → Hello (unicast) → Pair (HTTP)
 *
 * JSON over UDP for simplicity. Same multicast group as mdns transport.
 */

import { randomBytes } from "crypto";

export const SCOUT_VERSION = 1;
export const MULTICAST_ADDR = "224.0.0.224";
export const MULTICAST_PORT = 31746;

export type WhatAmI = "oracle" | "hub" | "bridge";

export interface ScoutMessage {
  type: "maw-scout";
  version: number;
  zid: string;
  whatAmI: WhatAmI;
  ts: number;
}

export interface HelloMessage {
  type: "maw-hello";
  version: number;
  zid: string;
  whatAmI: WhatAmI;
  node: string;
  oracle: string;
  locators: string[];
  capabilities: string[];
  oracles: string[];
  ts: number;
}

export interface AnnounceMessage {
  type: "maw-announce";
  node: string;
  port: number;
  oracles: string[];
  ts: number;
}

export type ScoutProtocolMessage = ScoutMessage | HelloMessage | AnnounceMessage;

export function generateZid(): string {
  return randomBytes(16).toString("hex");
}

export function greaterZid(a: string, b: string): boolean {
  return a > b;
}

export function makeScout(zid: string, whatAmI: WhatAmI = "oracle"): ScoutMessage {
  return { type: "maw-scout", version: SCOUT_VERSION, zid, whatAmI, ts: Date.now() };
}

export function makeHello(opts: {
  zid: string;
  node: string;
  oracle: string;
  locators: string[];
  capabilities?: string[];
  oracles?: string[];
  whatAmI?: WhatAmI;
}): HelloMessage {
  return {
    type: "maw-hello",
    version: SCOUT_VERSION,
    zid: opts.zid,
    whatAmI: opts.whatAmI ?? "oracle",
    node: opts.node,
    oracle: opts.oracle,
    locators: opts.locators,
    capabilities: opts.capabilities ?? ["pair", "feed", "send"],
    oracles: opts.oracles ?? [],
    ts: Date.now(),
  };
}

export function parseMessage(buf: Buffer): ScoutProtocolMessage | null {
  try {
    const msg = JSON.parse(buf.toString());
    if (msg.type === "maw-scout" || msg.type === "maw-hello" || msg.type === "maw-announce") {
      return msg as ScoutProtocolMessage;
    }
    return null;
  } catch {
    return null;
  }
}
