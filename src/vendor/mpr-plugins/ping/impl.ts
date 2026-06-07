import { loadConfig, cfgTimeout } from "maw-js/config";
import { curlFetch } from "maw-js/sdk";

export async function cmdPing(node?: string) {
  const config = loadConfig();
  const peers = config.namedPeers || [];
  const legacyPeers = (config.peers || []).filter(
    (url: string) => !peers.some((p: any) => p.url === url)
  );

  const targets: { name: string; url: string }[] = [];

  if (node) {
    // Ping specific node
    const peer = peers.find((p: any) => p.name === node);
    if (peer) {
      targets.push({ name: peer.name, url: peer.url });
    } else {
      const legacy = legacyPeers.find((u: string) => u.includes(node));
      if (legacy) targets.push({ name: node, url: legacy });
      else {
        console.error(`\x1b[33mknown\x1b[0m: ${peers.map((p: any) => p.name).join(", ") || "(none)"}`);
        throw new Error(`unknown node "${node}"`);
      }
    }
  } else {
    // Ping all
    for (const p of peers) targets.push({ name: p.name, url: p.url });
    for (const url of legacyPeers) targets.push({ name: url, url });
  }

  if (targets.length === 0) {
    console.log("\x1b[90mno peers configured\x1b[0m");
    return;
  }

  const results = await Promise.all(targets.map(async ({ name, url }) => {
    const start = Date.now();
    try {
      const res = await curlFetch(`${url}/api/auth/status`, { timeout: cfgTimeout("ping") });
      const ms = Date.now() - start;
      if (res.ok) {
        const auth = res.data?.enabled ? "auth: ok" : "auth: off";
        const token = res.data?.tokenPreview || "";
        return { name, url, ok: true, ms, auth, token };
      }
      return { name, url, ok: false, ms, auth: `${res.status}`, token: "" };
    } catch {
      return { name, url, ok: false, ms: Date.now() - start, auth: "unreachable", token: "" };
    }
  }));

  for (const r of results) {
    if (r.ok) {
      console.log(`\x1b[32m✅\x1b[0m ${r.name} \x1b[90m(${r.url})\x1b[0m — ${r.ms}ms, ${r.auth}${r.token ? ` (${r.token})` : ""}`);
    } else {
      console.log(`\x1b[31m❌\x1b[0m ${r.name} \x1b[90m(${r.url})\x1b[0m — ${r.ms}ms, ${r.auth}`);
    }
  }
}
