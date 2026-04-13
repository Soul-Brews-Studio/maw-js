/**
 * Hot-reload watcher — debounced file change → onReload callback.
 * Disable via MAW_HOT_RELOAD=0.
 */

export function watchUserPlugins(
  dir: string,
  onReload: (changedFile: string) => void | Promise<void>,
  debounceMs = 200,
): () => void {
  if (process.env.MAW_HOT_RELOAD === "0") return () => {};

  const { watch, existsSync } = require("fs");
  if (!existsSync(dir)) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastChanged = "";

  let watcher: { close: () => void };
  try {
    watcher = watch(dir, { persistent: false }, (_: string, filename: string | null) => {
      if (!filename || !/\.(ts|js|wasm)$/.test(filename)) return;
      lastChanged = filename;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        Promise.resolve(onReload(lastChanged)).catch((err) => {
          console.error(`[plugin:reload] failed for ${lastChanged}:`, (err as Error).message);
        });
      }, debounceMs);
    });
  } catch (err) {
    console.error(`[plugin:watch] cannot watch ${dir}:`, (err as Error).message);
    return () => {};
  }

  return () => { if (timer) clearTimeout(timer); try { watcher.close(); } catch {} };
}
