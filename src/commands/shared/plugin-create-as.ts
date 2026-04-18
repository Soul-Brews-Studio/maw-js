import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { copyTree, buildManifestJson, TEMPLATE_AS } from "./plugin-create-scaffold";

export function scaffoldAs(name: string, dest: string, templateDir = TEMPLATE_AS): void {
  if (!existsSync(templateDir)) {
    throw new Error(
      `AssemblyScript template not found at ${templateDir}\n` +
      `  The AS SDK is still being built — try again after the next maw update,\n` +
      `  or check: https://github.com/Soul-Brews-Studio/maw-js`,
    );
  }

  copyTree(templateDir, dest);

  // Rewrite package.json name
  const pkgPath = join(dest, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.name = name;
    // lgtm[js/file-system-race] — PRIVATE-PATH: rewrites package.json in user-owned scaffold dest, see docs/security/file-system-race-stance.md
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }

  // Write README
  writeFileSync(
    join(dest, "README.md"),
    `# ${name}

A maw WASM command plugin (AssemblyScript).

## Build

\`\`\`bash
cd "${dest}"
npm install
npm run build
\`\`\`

Output: \`build/${name}.wasm\`

## Install

\`\`\`bash
maw plugin install "${dest}"
\`\`\`
`,
  );

  // Emit plugin.json manifest
  writeFileSync(join(dest, "plugin.json"), buildManifestJson(name, "as"));
}
