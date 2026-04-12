/**
 * Built-in: Shell hooks — fire configured ~/.oracle/maw.hooks.json scripts.
 * Extracted from server.ts inline feedListener.
 */
import type { MawHooks } from "../../plugins";

export default function(hooks: MawHooks) {
  let runHook: (event: string, ctx: Record<string, string>) => Promise<void>;
  try {
    runHook = require("../../hooks").runHook;
  } catch {
    return; // hooks module not available — skip silently
  }

  hooks.on("*", (event) => {
    runHook(event.event, {
      from: event.oracle,
      to: event.oracle,
      message: event.message,
      channel: "feed",
    }).catch((err: Error) => {
      console.error("[hooks]", event.event, err.message);
    });
  });
}
