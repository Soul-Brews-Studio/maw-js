const [secondsRaw, ...command] = Bun.argv.slice(2);
const seconds = Number(secondsRaw);

if (!Number.isFinite(seconds) || seconds <= 0 || command.length === 0) {
  console.error("usage: bun scripts/run-with-timeout.ts <seconds> <command> [args...]");
  process.exit(2);
}

const child = Bun.spawn(command, {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let timedOut = false;
let forceKill: ReturnType<typeof setTimeout> | undefined;
const deadline = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
}, seconds * 1_000);

const exitCode = await child.exited;
clearTimeout(deadline);
if (forceKill) clearTimeout(forceKill);
process.exit(timedOut ? 124 : exitCode);
