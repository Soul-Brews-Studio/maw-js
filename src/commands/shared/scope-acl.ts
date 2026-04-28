/**
 * scope-acl.ts — pure ACL evaluation for cross-oracle messages (#642 Phase 2 /
 * Sub-A of #842).
 *
 * Phase 1 (#829) shipped the scope primitive + `maw scope` CLI (list / create
 * / show / delete) writing per-scope JSON files at `<CONFIG_DIR>/scopes/<name>.json`.
 * Phase 2 introduces the routing decision: given a sender → target message
 * pair and the current scope set, should we deliver immediately or queue the
 * message for operator approval?
 *
 * This sub-PR (Sub-A of #842) ships JUST the pure decision function plus a
 * filesystem-aware loader (`loadAllScopes`). It does NOT wire into
 * `comm-send.ts` — caller integration lives in Sub-B/C so that this PR can
 * focus on the ACL semantics + tests without entangling the send hot path.
 *
 * Trust list: Sub-B will introduce a `<CONFIG_DIR>/trust.json` (or similar)
 * holding pairwise sender↔target whitelist entries that override scope
 * membership. The TrustList shape is declared here so the decision function
 * can already accept it; for Sub-A the caller passes `undefined` (or omits
 * the argument) and the helper treats trust as empty.
 *
 * Decision matrix:
 *
 *   sender == target                                  → "allow"  (self-msg)
 *   sender + target share at least one scope          → "allow"
 *   sender + target both listed in trust list         → "allow"
 *   otherwise                                         → "queue"  (default-deny
 *                                                                 cross)
 *
 * The function is intentionally pure — no I/O, no module dependencies on
 * file-system primitives. `loadAllScopes` is the dirty edge that mirrors
 * `cmdList()` in `src/commands/plugins/scope/impl.ts`. Mirrors the
 * pure-function pattern from `src/commands/shared/should-auto-wake.ts` (#837).
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { scopesDir } from "../plugins/scope/impl";
import type { TScope } from "../../lib/schemas";

/**
 * Pairwise trust-list entry. Sub-B will define the on-disk file format and
 * loader. The shape exists here so the ACL function can already accept it
 * without a follow-up signature change.
 *
 * Semantics (Sub-A scaffolding — Sub-B will lock these down):
 *   - `sender` / `target` are oracle names matching `Scope.members[*]`
 *   - Trust is symmetric: a pair {a, b} means a→b AND b→a are allowed
 *   - The list is consulted ONLY when scope membership doesn't already allow
 */
export interface TrustEntry {
  sender: string;
  target: string;
}

/** A flat list of trust entries. May be empty / undefined in Sub-A. */
export type TrustList = TrustEntry[];

/** Decision returned by {@link evaluateAcl}. */
export type AclDecision = "allow" | "queue";

/**
 * Decide whether a `sender → target` message should be delivered immediately
 * or queued for operator approval.
 *
 * Pure function — no I/O. Callers feed pre-loaded scopes (use
 * {@link loadAllScopes} for the canonical filesystem read) and an optional
 * trust list. The decision is deterministic and order-independent.
 *
 * @param sender   oracle name initiating the message
 * @param target   oracle name receiving the message
 * @param scopes   the full set of scopes the operator has defined; may be empty
 * @param trust    optional pairwise trust list (Sub-B); undefined = empty
 * @returns "allow" if any rule grants delivery, "queue" otherwise
 */
export function evaluateAcl(
  sender: string,
  target: string,
  scopes: TScope[],
  trust?: TrustList,
): AclDecision {
  // 1. Self-messages are always allowed. An oracle hey-ing itself never
  //    needs operator approval — there's no cross-trust boundary to cross.
  if (sender === target) return "allow";

  // 2. Scope overlap: if any scope's members include BOTH sender and target,
  //    delivery is allowed. Multi-scope membership composes naturally — the
  //    sender (or target) may belong to several scopes, and ANY shared scope
  //    suffices. We don't require the membership to be in the same scope row;
  //    we require a shared scope, which is the same thing.
  for (const s of scopes) {
    if (s.members.includes(sender) && s.members.includes(target)) {
      return "allow";
    }
  }

  // 3. Trust list overrides scope absence. Sub-B will define how this list is
  //    written; for Sub-A we accept any caller-supplied list. Symmetric
  //    matching means {a, b} grants both directions.
  if (trust && trust.length > 0) {
    for (const t of trust) {
      if (
        (t.sender === sender && t.target === target) ||
        (t.sender === target && t.target === sender)
      ) {
        return "allow";
      }
    }
  }

  // 4. Default-deny: queue for operator approval. Phase 2 (#842 Sub-C) will
  //    persist queued messages to the approval queue so an operator can
  //    `maw scope approve <id>` after review.
  return "queue";
}

/**
 * Read every scope JSON file under `<CONFIG_DIR>/scopes/` and return the
 * decoded `TScope[]` array. Mirrors the body of `cmdList()` in
 * `src/commands/plugins/scope/impl.ts` so callers that only need the data
 * (not the CLI verb) can avoid pulling in the full plugin module's surface
 * area when wiring future ACL checks.
 *
 * Failure modes mirror Phase 1 forgiving semantics:
 *   - missing `scopes/` directory → returns `[]`
 *   - non-JSON files in the directory → ignored
 *   - corrupt JSON files → silently skipped
 *
 * Sub-A consumers don't yet exist — this is wiring for Sub-B/C. Shipping the
 * helper now keeps the ACL module self-contained and unit-testable without
 * a separate follow-up to extract this logic.
 */
export function loadAllScopes(): TScope[] {
  const dir = scopesDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const out: TScope[] = [];
  for (const f of files) {
    const path = `${dir}/${f}`;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as TScope;
      // Defensive: skip files that don't look like a Scope. Phase 1's writer
      // is the only path that touches these files in production, but operators
      // hand-edit scope JSON (it's a documented workflow — see
      // scope-primitive.test.ts "members list is editable on disk"), so a
      // typo'd file shouldn't take down the ACL evaluator.
      if (
        parsed &&
        typeof parsed.name === "string" &&
        Array.isArray(parsed.members)
      ) {
        out.push(parsed);
      }
    } catch {
      // Forgiving: skip corrupt files, same as cmdList(). Phase 2 may add a
      // louder diagnostic when the ACL evaluator is consulted in production.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
