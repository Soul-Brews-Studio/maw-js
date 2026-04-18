/**
 * AST-based capability inference — Phase B replacement for regex scanning.
 *
 * Problem with the Phase A regex approach:
 *   • `const { id } = maw; id()` — destructured usage escapes `maw\.(\w+)` regex
 *   • `const m = maw; m.identity()` — aliased binding escapes regex
 *   • `maw["wake"]()` — dynamic bracket-access escapes `maw\.\w+` regex
 *   • Transitive imports (`import maw from "maw-sdk"`) are not followed by regex
 *
 * This module uses the TypeScript Compiler API to:
 *   1. Parse the source into an AST (no type-checker needed — parse only).
 *   2. Walk import declarations to find the local name(s) bound to the maw SDK.
 *   3. Walk call expressions and member accesses to detect capability usage
 *      through any of the four patterns above.
 *
 * Invariant: outputs are equal-or-stricter than Phase A regex.
 * When the same source is fed to both, the AST path must detect everything
 * the regex path detects PLUS additional patterns the regex misses.
 *
 * SDK import specifiers that are treated as "maw" bindings:
 *   • "@maw-js/sdk", "maw", "maw-sdk", "maw/sdk" (all common forms)
 *   • Any import from those specifiers becomes a tracked binding.
 *
 * Module capability mappings (non-SDK):
 *   • "node:fs", "node:fs/promises" → fs:read
 *   • "node:child_process"          → proc:spawn
 *   • "bun:ffi"                     → ffi:any
 *   • global fetch()                → net:fetch
 */

import ts from "typescript";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Import specifiers recognised as the maw SDK. */
const MAW_SDK_SPECIFIERS = new Set(["@maw-js/sdk", "maw", "maw-sdk", "maw/sdk"]);

/** Module specifiers that map to a fixed capability (non-SDK). */
const MODULE_CAP_MAP: Record<string, string> = {
  "node:fs": "fs:read",
  "node:fs/promises": "fs:read",
  "node:child_process": "proc:spawn",
  "bun:ffi": "ffi:any",
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Infer capabilities from TypeScript/JavaScript source text using AST traversal.
 *
 * @param source - Raw source text (TS or JS)
 * @param fileName - Optional virtual file name for TS parser (affects dialect)
 * @returns Sorted, deduplicated capability strings
 */
export function inferCapabilitiesAst(source: string, fileName = "plugin.ts"): string[] {
  const caps = new Set<string>();

  // Parse into AST. We use `createSourceFile` (no type-checker) for speed.
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  // Phase 1: collect all local bindings that come from maw SDK imports.
  //
  // We track two kinds:
  //   • `mawDefaultBindings` — names bound to the default export (the maw object)
  //     e.g. `import maw from "@maw-js/sdk"` → "maw"
  //          `import * as maw from "@maw-js/sdk"` → "maw"
  //          `import mawAlias from "@maw-js/sdk"` → "mawAlias"
  //          `const m = maw; ...` → tracked via alias walk below
  //
  //   • `mawNamedBindings` — names bound to named exports (methods directly)
  //     e.g. `import { identity, send } from "@maw-js/sdk"` → { identity: "identity", send: "send" }
  //          `import { identity as id } from "@maw-js/sdk"` → { id: "identity" }
  //
  const mawDefaultBindings = new Set<string>(); // local names bound to maw object
  const mawNamedBindings = new Map<string, string>(); // local name → sdk method name

  collectImportBindings(sf, mawDefaultBindings, mawNamedBindings, caps);

  // Phase 2: walk the AST for alias assignments (`const m = maw`) and call sites.
  collectAliasAndCallSites(sf, mawDefaultBindings, mawNamedBindings, caps);

  return [...caps].sort();
}

// ─── Phase 1: import binding collection ──────────────────────────────────────

function collectImportBindings(
  sf: ts.SourceFile,
  mawDefaultBindings: Set<string>,
  mawNamedBindings: Map<string, string>,
  caps: Set<string>,
): void {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    // Extract the raw module specifier string (strip quotes).
    const specNode = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(specNode)) continue;
    const spec = specNode.text;

    // Non-SDK module capability mapping.
    if (spec in MODULE_CAP_MAP) {
      caps.add(MODULE_CAP_MAP[spec]);
      continue;
    }

    // SDK import — collect local bindings.
    if (!MAW_SDK_SPECIFIERS.has(spec)) continue;

    const clause = stmt.importClause;
    if (!clause) continue;

    // Default import: `import maw from "@maw-js/sdk"`
    if (clause.name) {
      mawDefaultBindings.add(clause.name.text);
    }

    const bindings = clause.namedBindings;
    if (!bindings) continue;

    if (ts.isNamespaceImport(bindings)) {
      // `import * as maw from "@maw-js/sdk"` — namespace is equivalent to default
      mawDefaultBindings.add(bindings.name.text);
    } else if (ts.isNamedImports(bindings)) {
      // `import { identity, send as s } from "@maw-js/sdk"`
      for (const el of bindings.elements) {
        // el.name is the local alias; el.propertyName is the exported name (if aliased).
        const localName = el.name.text;
        const exportedName = el.propertyName ? el.propertyName.text : localName;
        mawNamedBindings.set(localName, exportedName);
      }
    }
  }
}

// ─── Phase 2: alias assignments + call sites ─────────────────────────────────

function collectAliasAndCallSites(
  sf: ts.SourceFile,
  mawDefaultBindings: Set<string>,
  mawNamedBindings: Map<string, string>,
  caps: Set<string>,
): void {
  // First pass: collect variable aliases like `const m = maw` and destructures
  // like `const { identity } = maw` before walking call sites.
  collectVariableAliases(sf, mawDefaultBindings, mawNamedBindings);

  // Second pass: walk all call expressions and member accesses.
  walkNode(sf, mawDefaultBindings, mawNamedBindings, caps);
}

/**
 * Pre-pass: find alias and destructure patterns over maw bindings.
 *
 * Handles:
 *   • `const m = maw` — simple alias, adds "m" to mawDefaultBindings
 *   • `const { identity } = maw` — destructure, adds "identity" → "identity" to mawNamedBindings
 *   • `const { identity: id } = maw` — renamed destructure, adds "id" → "identity"
 *
 * This pre-pass runs BEFORE the call-site walk so aliases/destructures at any
 * scope level are captured before their call sites are visited.
 */
function collectVariableAliases(
  node: ts.Node,
  mawDefaultBindings: Set<string>,
  mawNamedBindings: Map<string, string>,
): void {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const init = node.initializer;

    if (ts.isIdentifier(init) && mawDefaultBindings.has(init.text)) {
      if (ts.isIdentifier(node.name)) {
        // Pattern: `const m = maw` — simple alias
        mawDefaultBindings.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        // Pattern: `const { identity, send: s } = maw` — destructure
        for (const el of node.name.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            const localName = el.name.text;
            // el.propertyName is the original key if aliased: `{ identity: id }` → propertyName = "identity"
            const exportedName =
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : localName;
            mawNamedBindings.set(localName, exportedName);
          }
        }
      }
    }
  }
  ts.forEachChild(node, (child) => collectVariableAliases(child, mawDefaultBindings, mawNamedBindings));
}

/** Main AST walker — detects capability call sites. */
function walkNode(
  node: ts.Node,
  mawDefaultBindings: Set<string>,
  mawNamedBindings: Map<string, string>,
  caps: Set<string>,
): void {
  // Pattern A: `maw.method(...)` or `maw["method"](...)`
  if (ts.isCallExpression(node)) {
    const expr = node.expression;

    if (ts.isPropertyAccessExpression(expr)) {
      // maw.identity() — property access
      if (
        ts.isIdentifier(expr.expression) &&
        mawDefaultBindings.has(expr.expression.text)
      ) {
        caps.add(`sdk:${expr.name.text}`);
      }
    } else if (ts.isElementAccessExpression(expr)) {
      // maw["identity"]() or maw[varKey]() — bracket access
      if (
        ts.isIdentifier(expr.expression) &&
        mawDefaultBindings.has(expr.expression.text)
      ) {
        if (ts.isStringLiteral(expr.argumentExpression)) {
          // Static string key — we know the method name
          caps.add(`sdk:${expr.argumentExpression.text}`);
        } else {
          // Dynamic key — we can't know which method; emit sentinel
          caps.add("sdk:*dynamic*");
        }
      }
    } else if (ts.isIdentifier(expr)) {
      // Pattern B: named import used directly — `identity()` (from `import { identity }`)
      const exportedName = mawNamedBindings.get(expr.text);
      if (exportedName !== undefined) {
        caps.add(`sdk:${exportedName}`);
      }

      // Pattern C: global fetch() — not a member access
      if (expr.text === "fetch") {
        caps.add("net:fetch");
      }
    }
  }

  // Pattern D: non-SDK module capabilities (dynamic require / import() calls)
  // Handles: require("node:fs"), require("bun:ffi"), import("node:child_process")
  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    const arg0 = node.arguments[0];
    if (
      arg0 &&
      ts.isStringLiteral(arg0) &&
      (
        (ts.isIdentifier(expr) && expr.text === "require") ||
        expr.kind === ts.SyntaxKind.ImportKeyword
      )
    ) {
      const spec = arg0.text;
      if (spec in MODULE_CAP_MAP) {
        caps.add(MODULE_CAP_MAP[spec]);
      }
    }
  }

  ts.forEachChild(node, (child) =>
    walkNode(child, mawDefaultBindings, mawNamedBindings, caps),
  );
}
