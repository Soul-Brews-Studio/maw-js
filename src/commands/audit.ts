import { readAudit } from "../audit";

export async function cmdAudit(count = 20) {
  const lines = readAudit(count);
  if (!lines.length) {
    console.log("\x1b[90mNo audit entries yet.\x1b[0m");
    return;
  }
  console.log(`\x1b[36mAudit Trail\x1b[0m (last ${lines.length})\n`);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const date = new Date(entry.ts);
      const time = date.toLocaleString("en-GB", {
        month: "short", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
      });
      const args = entry.args?.length ? ` ${entry.args.join(" ")}` : "";
      const result = entry.result ? ` \x1b[90m→ ${entry.result}\x1b[0m` : "";
      console.log(`  \x1b[90m${time}\x1b[0m  \x1b[33m${entry.cmd}\x1b[0m${args}${result}`);
    } catch {
      console.log(`  \x1b[90m(malformed)\x1b[0m ${line.slice(0, 80)}`);
    }
  }
  console.log();
}
