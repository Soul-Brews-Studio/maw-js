/**
 * Plugin tarball download endpoint (Task #1, docs/plugins/at-peer-install.md §4.2).
 *
 * `GET /api/plugin/download/:name` → streams the installed plugin directory
 * as a gzipped tarball. Consumed by the `<name>@<peer>` install flow.
 *
 * Auth: mounted under the /api prefix in src/api/index.ts, so the same
 * federationAuth HMAC middleware that guards /plugin/list-manifest guards
 * this too. No new auth surface.
 *
 * Why re-tar is safe: plugin artifact sha256 hashes a single FILE
 * (manifest.artifact.path), not the tarball. So identical plugin dirs
 * tarred on different nodes produce tarballs with different sha256 but
 * IDENTICAL artifact hash — the client's plugins.lock check stays sound.
 *
 * Refuses to serve `--link` (dev) installs: those are the author's
 * working tree, not a releasable artifact, and the tar would expose
 * node_modules + .git + anything else the author left in the source
 * dir. 409 is the user-visible signal to rebuild + install a real
 * artifact.
 */
import { Elysia } from "elysia";
import { spawn } from "child_process";
import { lstatSync } from "fs";
import { discoverPackages } from "../plugin/registry";

export const pluginDownloadApi = new Elysia().get(
  "/plugin/download/:name",
  ({ params, set }) => {
    const name = params.name;
    const entry = discoverPackages().find(p => p.manifest.name === name);
    if (!entry) {
      set.status = 404;
      return { error: "plugin not installed", name };
    }

    // Reject --link dev installs. Their sha256 is meaningless (symlink to
    // author tree); serving them would let `@peer` install a working tree.
    let isSymlink = false;
    try {
      isSymlink = lstatSync(entry.dir).isSymbolicLink();
    } catch {
      // fall through — the tar below will surface whatever the real issue is
    }
    if (isSymlink) {
      set.status = 409;
      return {
        error: "plugin is --link (dev install) — rebuild + re-install a real artifact before serving",
        name,
      };
    }

    set.headers["Content-Type"] = "application/gzip";
    const filename = `${name}-${entry.manifest.version}.tgz`;
    set.headers["Content-Disposition"] = `attachment; filename="${filename}"`;

    // Stream `tar -czf - -C <pluginDir> .` directly through as the response.
    // Using ReadableStream so Bun/Elysia backpressure and cleanup are handled
    // by the platform, not a manual buffer/flush loop.
    const child = spawn("tar", ["-czf", "-", "-C", entry.dir, "."]);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        child.stdout.on("end", () => {
          controller.close();
        });
        child.on("error", err => {
          try { controller.error(err); } catch { /* already closed */ }
        });
        child.on("exit", code => {
          if (code !== 0 && code !== null) {
            try {
              controller.error(new Error(`tar exited with code ${code}`));
            } catch { /* already closed */ }
          }
        });
      },
      cancel() {
        child.kill("SIGTERM");
      },
    });
  },
);
