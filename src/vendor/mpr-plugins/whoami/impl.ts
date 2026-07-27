import { requireOracleIdentity } from "maw-js/sdk";
import { UserError } from "maw-js/core/util/user-error";

/**
 * maw whoami — print the current oracle identity on stdout.
 */
export async function cmdWhoami() {
  try {
    console.log(requireOracleIdentity().name);
  } catch (error: any) {
    throw new UserError(error.message);
  }
}
