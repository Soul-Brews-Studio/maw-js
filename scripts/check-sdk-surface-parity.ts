#!/usr/bin/env bun
/**
 * check-sdk-surface-parity.ts — CI guardrail for #2750.
 *
 * Vendor plugins import the repo-local `maw-js/sdk` barrel while external
 * plugin authors see `packages/sdk/index.d.ts`. Keep the declaration surface
 * honest: every vendor-used SDK symbol must be declared publicly, and any
 * public declaration not currently exercised by vendor plugins must be an
 * explicitly reviewed public export.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const SDK_SPECIFIER = "maw-js/sdk";
const DEFAULT_SDK_DTS = "packages/sdk/index.d.ts";
const DEFAULT_VENDOR_ROOTS = ["src/vendor/mpr-plugins", "src/vendor-plugins"];

// Public package exports that intentionally remain broader than today's
// in-repo vendor-plugin usage. New unused declarations should not silently
// appear: either a vendor plugin starts using them, or this reviewed set must
// be updated in the same PR with rationale.
const REVIEWED_PUBLIC_EXPORTS = new Set([
  "AgentRow",
  "ArtifactMeta",
  "ArtifactSummary",
  "ChannelPlugin",
  "ConfigProvenanceEntry",
  "ConfigSource",
  "ConsentStatus",
  "DefinedPlugin",
  "DisabledFleetEntry",
  "EventToHandlerName",
  "FederationStatus",
  "FeedEvent",
  "FeedEventType",
  "FleetSession",
  "FleetWindow",
  "HandlersFor",
  "Identity",
  // Public return shape for the persistent inbox status-line badge helper;
  // external plugins can branch on set/cleared/unchanged/failed without
  // importing repo-internal tmux decoration code.
  "InboxStatusBadgeResult",
  "LifecycleRunSummary",
  "LoadConfigOptions",
  "LoadedConfigWithProvenance",
  "MawSdk",
  "MessageChannel",
  "MessageDirection",
  "MessageLifecycleData",
  "MessageLifecycleInput",
  "MessageRoute",
  "MessageState",
  "OracleChannelConfig",
  "OracleMember",
  "OracleTeamRegistry",
  "ParsedWakeTarget",
  "Peer",
  "PendingRequest",
  "PluginEventMap",
  "PluginInfo",
  "PluginManifestInput",
  "PrintHelpers",
  "ResolveResult",
  "ShouldAutoWakeDecision",
  "Signal",
  "SignalKind",
  "SleepLifecycleContextInput",
  "TmuxSession",
  "TmuxWindow",
  "TransportFailureReason",
  "TransportResult",
  "TransportTarget",
  "TrustEntry",
  "ValidateExports",
  "addAttachment",
  "artifactDir",
  "buildCommand",
  "buildCommandInDir",
  "buildMessageLifecycleData",
  "buildMessageLifecycleFeedEvent",
  "countDisabledFleetFilesCore",
  "createArtifact",
  "filterMembers",
  "fleetLoadDirsForRead",
  "getArtifact",
  "getChannelEnv",
  "getOracleMembers",
  "importPluginSymbol",
  "isMessageLifecycleData",
  "isUserError",
  "legacyOracleHookConfigPath",
  "legacyOracleMessageLogPath",
  "listAllOracleChannels",
  "listArtifacts",
  "loadConfigWithProvenance",
  "loadDisabledFleetEntriesCore",
  "loadOracleChannels",
  "loadRepoChannels",
  "maw",
  "mawCachePath",
  "mawConfigPath",
  "mawHookConfigCandidatePaths",
  "mawMessageLogCandidatePaths",
  "mawRuntimeHomeDir",
  "resolveWorktreeTarget",
  "saveOracleChannels",
  "saveRepoChannels",
  "updateArtifact",
  "writeResult",
]);

export type SymbolUse = {
  symbol: string;
  file: string;
  line: number;
  kind: "import" | "export" | "dynamic-import" | "namespace-property";
};

export type SdkSurfaceParityResult = {
  ok: boolean;
  declaredExports: string[];
  vendorImports: string[];
  missingDeclarations: string[];
  unreviewedPublicExports: string[];
  usesBySymbol: Record<string, SymbolUse[]>;
  reviewedPublicExports: string[];
};

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function sourceFileFor(path: string): ts.SourceFile {
  const source = readFileSync(path, "utf8");
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function addDeclarationName(node: ts.Node, out: Set<string>): void {
  const name = (node as { name?: ts.Node }).name;
  if (name && ts.isIdentifier(name)) out.add(name.text);
}

export function collectDeclaredSdkExports(dtsPath = DEFAULT_SDK_DTS): Set<string> {
  const sourceFile = sourceFileFor(dtsPath);
  const exports = new Set<string>();

  function visit(node: ts.Node): void {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

    if (isExported) {
      if (
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)
      ) {
        addDeclarationName(node, exports);
      }
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) exports.add(declaration.name.text);
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) exports.add(element.name.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return exports;
}

function listSourceFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) listSourceFiles(path, out);
    else if (/\.tsx?$/.test(path) && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function recordUse(uses: SymbolUse[], sourceFile: ts.SourceFile, node: ts.Node, symbol: string, kind: SymbolUse["kind"]): void {
  uses.push({
    symbol,
    file: relative(process.cwd(), sourceFile.fileName),
    line: lineOf(sourceFile, node),
    kind,
  });
}

function moduleSpecifierText(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  const specifier = node.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : null;
}

function unwrapAwait(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAwaitExpression(current)) current = current.expression;
  return current;
}

function isSdkDynamicImport(expression: ts.Expression): boolean {
  const expr = unwrapAwait(expression);
  return ts.isCallExpression(expr)
    && expr.expression.kind === ts.SyntaxKind.ImportKeyword
    && expr.arguments.length === 1
    && ts.isStringLiteral(expr.arguments[0])
    && expr.arguments[0].text === SDK_SPECIFIER;
}

export function collectVendorSdkUses(vendorRoots = DEFAULT_VENDOR_ROOTS): SymbolUse[] {
  const files = vendorRoots
    .filter((root) => existsSync(root) && statSync(root).isDirectory())
    .flatMap((root) => listSourceFiles(root));
  const uses: SymbolUse[] = [];

  for (const file of files) {
    const sourceFile = sourceFileFor(file);
    const namespaceImports = new Set<string>();

    function visitImports(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && moduleSpecifierText(node) === SDK_SPECIFIER) {
        const clause = node.importClause;
        if (clause?.name) recordUse(uses, sourceFile, clause.name, "default", "import");
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            recordUse(uses, sourceFile, element, (element.propertyName ?? element.name).text, "import");
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          namespaceImports.add(bindings.name.text);
        }
      }

      if (ts.isExportDeclaration(node) && moduleSpecifierText(node) === SDK_SPECIFIER && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          recordUse(uses, sourceFile, element, (element.propertyName ?? element.name).text, "export");
        }
      }

      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isSdkDynamicImport(node.initializer)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
            recordUse(uses, sourceFile, element, property, "dynamic-import");
          }
        }
      }

      const expression = ts.isPropertyAccessExpression(node) ? node.expression : null;
      if (expression && ts.isIdentifier(expression) && namespaceImports.has(expression.text)) {
        recordUse(uses, sourceFile, node, node.name.text, "namespace-property");
      }

      if (ts.isPropertyAccessExpression(node) && isSdkDynamicImport(node.expression)) {
        recordUse(uses, sourceFile, node, node.name.text, "dynamic-import");
      }

      ts.forEachChild(node, visitImports);
    }

    visitImports(sourceFile);
  }

  return uses;
}

export function compareSdkSurface(
  declaredExports: Iterable<string>,
  vendorUses: Iterable<Pick<SymbolUse, "symbol">>,
  reviewedPublicExports: Iterable<string> = REVIEWED_PUBLIC_EXPORTS,
): Omit<SdkSurfaceParityResult, "usesBySymbol"> {
  const declared = new Set(declaredExports);
  const used = new Set([...vendorUses].map((use) => use.symbol));
  const reviewed = new Set(reviewedPublicExports);

  const missingDeclarations = sorted([...used].filter((symbol) => !declared.has(symbol)));
  const unreviewedPublicExports = sorted([...declared].filter((symbol) => !used.has(symbol) && !reviewed.has(symbol)));

  return {
    ok: missingDeclarations.length === 0 && unreviewedPublicExports.length === 0,
    declaredExports: sorted(declared),
    vendorImports: sorted(used),
    missingDeclarations,
    unreviewedPublicExports,
    reviewedPublicExports: sorted(reviewed),
  };
}

export function analyzeSdkSurfaceParity(options: {
  dtsPath?: string;
  vendorRoots?: string[];
  reviewedPublicExports?: Iterable<string>;
} = {}): SdkSurfaceParityResult {
  const uses = collectVendorSdkUses(options.vendorRoots ?? DEFAULT_VENDOR_ROOTS);
  const usesBySymbol: Record<string, SymbolUse[]> = {};
  for (const use of uses) {
    usesBySymbol[use.symbol] ??= [];
    usesBySymbol[use.symbol].push(use);
  }
  const compared = compareSdkSurface(
    collectDeclaredSdkExports(options.dtsPath ?? DEFAULT_SDK_DTS),
    uses,
    options.reviewedPublicExports ?? REVIEWED_PUBLIC_EXPORTS,
  );
  return { ...compared, usesBySymbol };
}

export function formatSdkSurfaceParityFailure(result: SdkSurfaceParityResult): string {
  const lines = ["✗ SDK surface parity gate failed (#2750):"];
  if (result.missingDeclarations.length > 0) {
    lines.push("", "Vendor plugins import symbols missing from packages/sdk/index.d.ts:");
    for (const symbol of result.missingDeclarations) {
      const locations = (result.usesBySymbol[symbol] ?? [])
        .slice(0, 5)
        .map((use) => `${use.file}:${use.line} (${use.kind})`)
        .join(", ");
      lines.push(`  - ${symbol}${locations ? ` — ${locations}` : ""}`);
    }
  }
  if (result.unreviewedPublicExports.length > 0) {
    lines.push("", "Public SDK declarations not used by vendor plugins or reviewed as stable public exports:");
    for (const symbol of result.unreviewedPublicExports) lines.push(`  - ${symbol}`);
  }
  lines.push("", "Fix: declare missing vendor-used SDK symbols, remove accidental declarations, or add intentional broader public exports to REVIEWED_PUBLIC_EXPORTS with rationale.");
  return lines.join("\n");
}

if (import.meta.main) {
  const result = analyzeSdkSurfaceParity();
  console.log(`sdk surface parity gate: ${result.vendorImports.length} vendor-used symbol(s), ${result.declaredExports.length} declared public export(s)`);
  if (!result.ok) {
    console.error(formatSdkSurfaceParityFailure(result));
    process.exit(1);
  }
  console.log("✓ sdk surface parity gate passed");
}
