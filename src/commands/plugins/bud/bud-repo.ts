import { hostExec } from "../../../sdk";
import { existsSync } from "fs";

/**
 * Step 1: Ensure the oracle's GitHub repo exists and is cloned locally.
 * Idempotent — skips creation/clone if already present.
 */
export async function ensureBudRepo(
  budRepoSlug: string,
  budRepoPath: string,
  budRepoName: string,
  org: string,
): Promise<void> {
  if (existsSync(budRepoPath)) {
    console.log(`  \x1b[90m○\x1b[0m repo already exists: ${budRepoPath}`);
    return;
  }
  console.log(`  \x1b[36m⏳\x1b[0m creating repo: ${budRepoSlug}...`);
  try {
    // Pre-check: if repo already exists on GitHub, skip creation
    const viewCheck = await hostExec(`gh repo view ${budRepoSlug} --json name 2>/dev/null`).catch(() => "");
    if (viewCheck.includes(budRepoName)) {
      console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
    } else {
      await hostExec(`gh repo create ${budRepoSlug} --private --add-readme`);
      console.log(`  \x1b[32m✓\x1b[0m repo created on GitHub`);
    }
  } catch (e: any) {
    if (e.message?.includes("already exists")) {
      console.log(`  \x1b[90m○\x1b[0m repo already exists on GitHub`);
    } else if (e.message?.includes("403") || e.message?.includes("admin")) {
      throw new Error(
        `no permission to create repos in ${org} — ask an org admin to create ${budRepoSlug} first, then re-run maw bud`,
      );
    } else {
      throw e;
    }
  }
  await hostExec(`ghq get github.com/${budRepoSlug}`);
  // #421 — verify landing path matches stated org. ghq honors the URL so this
  // should always pass; if it doesn't, a stale ghq entry or reroute is masking
  // the real location. Fail loudly rather than let wake resolve to the wrong org.
  if (!existsSync(budRepoPath)) {
    throw new Error(
      `clone landed outside expected path — expected ${budRepoPath} but not found on disk after ghq get.\n` +
      `  Check: ghq list | grep ${budRepoName}\n` +
      `  The --org flag may be shadowed by a stale clone in another org.`,
    );
  }
  console.log(`  \x1b[32m✓\x1b[0m cloned via ghq → ${budRepoPath}`);
}
