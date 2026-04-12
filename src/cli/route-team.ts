import { cmdTeamShutdown, cmdTeamList, cmdCleanupZombies } from "../commands/team";

export async function routeTeam(cmd: string, args: string[]): Promise<boolean> {
  if (cmd === "team") {
    const sub = args[1]?.toLowerCase();
    if (sub === "shutdown" || sub === "down") {
      if (!args[2]) {
        console.error("usage: maw team shutdown <name> [--force]");
        process.exit(1);
      }
      await cmdTeamShutdown(args[2], { force: args.includes("--force") });
    } else if (sub === "list" || sub === "ls" || !sub) {
      await cmdTeamList();
    } else {
      console.error(`unknown team subcommand: ${sub}`);
      console.error("usage: maw team <shutdown|list>");
      process.exit(1);
    }
    return true;
  }

  if (cmd === "cleanup") {
    if (args.includes("--zombie-agents") || args.includes("--zombies")) {
      await cmdCleanupZombies({ yes: args.includes("--yes") || args.includes("-y") });
      return true;
    }
    // Don't consume other cleanup subcommands
    return false;
  }

  return false;
}
