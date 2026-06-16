import { execSync } from "child_process";
import { loadConfig, cfgTimeout, curlFetch, tmux } from "maw-js/sdk";

export async function cmdHealth() {
  const checks: { name: string; status: string; detail: string }[] = [];

  // 1. tmux
  try {
    const sessions = await tmux.listSessions();
    checks.push({ name: "tmux server", status: "ok", detail: `running (${sessions.length} sessions)` });
  } catch {
    checks.push({ name: "tmux server", status: "fail", detail: "not running" });
  }

  // 2. maw server — POST /api/probe (#804 Step 5)
  // We POST /api/probe (not GET /api/sessions or /api/identity) because the
  // probe walks the same code path as /api/send. If probe is green, /send
  // is green; a green /sessions or /identity could coexist with broken /send
  // (the #795 schema-drift incident). No body → bare healthcheck mode.
  try {
    const port = loadConfig().port;
    const res = await fetch(`http://localhost:${port}/api/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(cfgTimeout("health")),
    });
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      const count = typeof data?.sessions === "number" ? data.sessions : "?";
      checks.push({ name: "maw server", status: "ok", detail: `online (:${port}, ${count} sessions, probe ok)` });
    } else {
      checks.push({ name: "maw server", status: "warn", detail: `HTTP ${res.status} (probe)` });
    }
  } catch {
    checks.push({ name: "maw server", status: "fail", detail: "offline" });
  }

  // 3. disk
  try {
    const df = execSync("df -h /tmp | tail -1", { encoding: "utf-8" }).trim();
    const parts = df.split(/\s+/);
    const avail = parts[3] || "?";
    const pct = parseInt(parts[4] || "0");
    checks.push({ name: "disk /tmp", status: pct > 90 ? "warn" : "ok", detail: `${avail} free` });
  } catch {
    checks.push({ name: "disk /tmp", status: "warn", detail: "unknown" });
  }

  // 4. memory — cross-platform: linux=free, macOS=vm_stat (#1121)
  try {
    let availMB = 0;
    if (process.platform === "darwin") {
      // macOS: vm_stat reports pages free + inactive (reusable). Page size = 16384 on Apple Silicon, 4096 on Intel.
      const vm = execSync("vm_stat", { encoding: "utf-8" });
      const pageSize = parseInt(execSync("sysctl -n hw.pagesize", { encoding: "utf-8" }).trim() || "16384");
      const free = parseInt(vm.match(/Pages free:\s+(\d+)/)?.[1] || "0");
      const inactive = parseInt(vm.match(/Pages inactive:\s+(\d+)/)?.[1] || "0");
      availMB = Math.round(((free + inactive) * pageSize) / 1024 / 1024);
    } else {
      // Linux: free -m, column 7 (available)
      const mem = execSync("free -m | grep Mem", { encoding: "utf-8" }).trim();
      availMB = parseInt(mem.split(/\s+/)[6] || "0");
    }
    checks.push({ name: "memory", status: availMB < 500 ? "warn" : "ok", detail: `${availMB}MB available` });
  } catch {
    checks.push({ name: "memory", status: "warn", detail: "unknown" });
  }

  // 5. pm2 — #1916 LOW-3: project moved off pm2 (fleet-resume.ts now), so
  // only report when pm2 actually has a maw process. A clean miss isn't a
  // failure; if any process named 'maw' shows up the user wants to know.
  try {
    const pm2 = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8" });
    const procs = JSON.parse(pm2);
    const maw = procs.find((p: any) => p.name === "maw");
    if (maw) {
      checks.push({ name: "pm2 maw", status: maw.pm2_env?.status === "online" ? "ok" : "warn", detail: `${maw.pm2_env?.status} (pid ${maw.pid})` });
    }
    // No maw under pm2 is the expected state now — don't emit a check at all.
  } catch {
    // pm2 not installed — also expected. Stay silent.
  }

  // 6. peers — reconcile both config.peers (string[]) and config.namedPeers ({name,url}[])
  const config = loadConfig();
  const rawPeers: string[] = config.peers || [];
  const namedPeers: { name: string; url: string }[] = config.namedPeers || [];
  const allPeers: { label: string; url: string }[] = [
    ...rawPeers.map(url => ({ label: url, url })),
    ...namedPeers.map(p => ({ label: `${p.name} (${p.url})`, url: p.url })),
  ];
  if (allPeers.length === 0) {
    checks.push({ name: "peers", status: "none", detail: "none configured" });
  } else {
    for (const peer of allPeers) {
      try {
        // #1979: probe the delivery write-path (POST /api/probe), NOT
        // GET /api/federation/status. Health must reflect what `maw hey`
        // can actually do — the status endpoint can drift from real delivery
        // capability in either direction (reported broken while /api/send
        // delivers fine here; reported online while broken in #1810).
        // /api/probe walks the same resolveTarget path as /api/send, so this
        // mirrors the local "maw server" check above (#804 Step 5 rationale).
        const r = await curlFetch(`${peer.url}/api/probe`, {
          method: "POST",
          body: "{}",
          from: "auto", // sign like /api/send so the probe is delivery-faithful
          timeout: cfgTimeout("health"),
        });
        checks.push({ name: `peer ${peer.label}`, status: r.ok ? "ok" : "warn", detail: r.ok ? "online (delivery ok)" : `HTTP ${r.status} (probe)` });
      } catch {
        checks.push({ name: `peer ${peer.label}`, status: "fail", detail: "unreachable" });
      }
    }
  }

  // Output
  console.log("\nmaw health\n");
  for (const c of checks) {
    const icon = c.status === "ok" ? "\x1b[32m●\x1b[0m" : c.status === "warn" ? "\x1b[33m●\x1b[0m" : c.status === "fail" ? "\x1b[31m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    console.log(`  ${icon} ${c.name.padEnd(18)} ${c.detail}`);
  }
  console.log();
}
