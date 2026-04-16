import { Tmux, tmux } from "./tmux-class";

// ─── Pane tagging (select-pane -T + set-option -p @...) ────────────────────

export interface TagPaneOpts {
  /** Pane title — surfaces in status bar + pane_title format. */
  title?: string;
  /** User-defined @options. Keys without leading "@" are prefixed automatically. */
  meta?: Record<string, string>;
  /** Tmux instance override (mainly for tests). */
  tmux?: Tmux;
}

/**
 * Set pane title and/or @custom options. Programmatic counterpart to
 * `maw tag` — callable from other plugins without forking a CLI.
 */
export async function tagPane(target: string, opts: TagPaneOpts = {}): Promise<void> {
  const t = opts.tmux ?? tmux;
  if (opts.title !== undefined) {
    await t.run("select-pane", "-t", target, "-T", opts.title);
  }
  for (const [rawKey, val] of Object.entries(opts.meta ?? {})) {
    const key = rawKey.startsWith("@") ? rawKey : `@${rawKey}`;
    await t.run("set-option", "-p", "-t", target, key, val);
  }
}

export interface PaneTags {
  title: string;
  meta: Record<string, string>;
}

/** Read pane title + @custom options. Counterpart to `tagPane`. */
export async function readPaneTags(
  target: string,
  opts: { tmux?: Tmux } = {},
): Promise<PaneTags> {
  const t = opts.tmux ?? tmux;
  const title = (await t.run("display-message", "-p", "-t", target, "#{pane_title}")).trim();
  const raw = await t.tryRun("show-options", "-p", "-t", target);
  const meta: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(@[^\s]+)\s+(?:"((?:[^"\\]|\\.)*)"|(.+))$/);
    if (m) meta[m[1]] = m[2] !== undefined ? m[2].replace(/\\"/g, '"') : (m[3] ?? "");
  }
  return { title, meta };
}
