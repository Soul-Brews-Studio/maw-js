import { cmdView } from "../commands/view";
import { cmdCompletions } from "../commands/completions";
import { cmdTab } from "../commands/tab";
import { cmdRename } from "../commands/rename";
import { cmdWorkon } from "../commands/workon";
import { cmdPark, cmdParkLs, cmdResume } from "../commands/park";
import { cmdContactsLs, cmdContactsAdd, cmdContactsRm } from "../commands/contacts";
import { cmdInboxLs, cmdInboxRead, cmdInboxWrite } from "../commands/inbox";
import { cmdAssign } from "../commands/assign";
import { cmdPr } from "../commands/pr";
import { cmdCosts } from "../commands/costs";
import { cmdTriggers } from "../commands/triggers";
import { cmdHealth } from "../commands/health";

export async function routeTools(cmd: string, args: string[]): Promise<boolean> {
  if (cmd === "view" || cmd === "create-view" || cmd === "attach" || cmd === "a") {
    if (!args[1]) { console.error("usage: maw view <agent> [window] [--clean]"); process.exit(1); }
    const clean = args.includes("--clean");
    const viewArgs = args.slice(1).filter(a => a !== "--clean");
    await cmdView(viewArgs[0], viewArgs[1], clean);
    return true;
  }
  if (cmd === "tab" || cmd === "tabs") {
    await cmdTab(args.slice(1));
    return true;
  }
  if (cmd === "park") {
    if (args[1] === "ls" || args[1] === "list") {
      await cmdParkLs();
    } else {
      await cmdPark(...args.slice(1));
    }
    return true;
  }
  if (cmd === "resume" || cmd === "unpause") {
    await cmdResume(args[1]);
    return true;
  }
  if (cmd === "inbox") {
    const sub = args[1]?.toLowerCase();
    if (sub === "read") await cmdInboxRead(args[2]);
    else if (sub === "write" && args[2]) await cmdInboxWrite(args.slice(2).join(" "));
    else await cmdInboxLs();
    return true;
  }
  if (cmd === "rename") {
    if (!args[1] || !args[2]) { console.error("usage: maw rename <tab# or name> <new-name>"); process.exit(1); }
    await cmdRename(args[1], args[2]);
    return true;
  }
  if (cmd === "contacts" || cmd === "contact") {
    const sub = args[1]?.toLowerCase();
    if (sub === "add" && args[2]) await cmdContactsAdd(args[2], args.slice(3));
    else if ((sub === "rm" || sub === "remove") && args[2]) await cmdContactsRm(args[2]);
    else await cmdContactsLs();
    return true;
  }
  if (cmd === "workon" || cmd === "work") {
    if (!args[1]) { console.error("usage: maw workon <repo> [task]"); process.exit(1); }
    await cmdWorkon(args[1], args[2]);
    return true;
  }
  if (cmd === "assign") {
    if (!args[1]) { console.error("usage: maw assign <issue-url> [--oracle <name>]"); process.exit(1); }
    let oracle: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--oracle" && args[i + 1]) { oracle = args[++i]; }
    }
    await cmdAssign(args[1], { oracle });
    return true;
  }
  if (cmd === "costs" || cmd === "cost") {
    await cmdCosts();
    return true;
  }
  if (cmd === "pr") {
    await cmdPr(args[1]);
    return true;
  }
  if (cmd === "triggers" || cmd === "trigger") {
    await cmdTriggers();
    return true;
  }
  if (cmd === "health" || cmd === "status") {
    await cmdHealth();
    return true;
  }
  if (cmd === "completions") {
    await cmdCompletions(args[1]);
    return true;
  }
  if (cmd === "ping") {
    const { cmdPing } = await import("../commands/ping");
    await cmdPing(args[1]);
    return true;
  }
  if (cmd === "transport" || cmd === "tp") {
    const sub = args[1]?.toLowerCase();
    if (!sub || sub === "status") {
      const { cmdTransportStatus } = await import("../commands/transport");
      await cmdTransportStatus();
    } else {
      console.error("usage: maw transport status");
      process.exit(1);
    }
    return true;
  }
  if (cmd === "avengers" || cmd === "avg") {
    const sub = args[1]?.toLowerCase();
    const { cmdAvengers } = await import("../commands/avengers");
    await cmdAvengers(sub || "status");
    return true;
  }
  if (cmd === "broker") {
    const { cmdBrokerStart, cmdBrokerStop, cmdBrokerStatus } = await import("../commands/broker");
    const sub = args[1]?.toLowerCase();
    if (sub === "start") await cmdBrokerStart();
    else if (sub === "stop") await cmdBrokerStop();
    else if (sub === "status" || !sub) await cmdBrokerStatus();
    else {
      console.log(`\x1b[36mmaw broker\x1b[0m — MQTT broker management\n`);
      console.log(`  maw broker start    Start local MQTT broker (prefers mosquitto, fallback aedes)`);
      console.log(`  maw broker stop     Stop the broker`);
      console.log(`  maw broker status   Check broker status + connections\n`);
    }
    return true;
  }
  if (cmd === "serve") {
    const hasMqtt = args.includes("--mqtt");
    const portArg = args.find(a => a !== "--mqtt" && a !== "serve" && /^\d+$/.test(a));
    if (hasMqtt) {
      const { cmdBrokerStart } = await import("../commands/broker");
      await cmdBrokerStart();
    }
    const { startServer } = await import("../server");
    startServer(portArg ? +portArg : 3456);
    return true;
  }
  return false;
}
