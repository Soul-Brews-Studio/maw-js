// Barrel re-export. The tmux abstraction is split across:
//   tmux-types.ts      — types + q() + resolveSocket() + tmuxCmd()
//   tmux-class.ts      — Tmux class + default `tmux` instance
//   tmux-pane-lock.ts  — withPaneLock + splitWindowLocked
//   tmux-pane-tags.ts  — tagPane + readPaneTags
// Importers should keep using `./tmux` — this stub forwards everything.

export type { TmuxPane, TmuxWindow, TmuxSession } from "./tmux-types";
export { resolveSocket, tmuxCmd } from "./tmux-types";
export { Tmux, tmux } from "./tmux-class";
export type { SplitWindowLockedOpts } from "./tmux-pane-lock";
export { withPaneLock, splitWindowLocked } from "./tmux-pane-lock";
export type { TagPaneOpts, PaneTags } from "./tmux-pane-tags";
export { tagPane, readPaneTags } from "./tmux-pane-tags";
