/**
 * cross-team-queue — shared contract re-export for UI / consumers.
 *
 * Mirrors the plugin's internal types so the api↔ui contract can live in
 * src/shared/ without forcing consumers to import from deep inside the plugin.
 *
 * Prior art: #505 adopted this same pattern for its built-in shape.
 */

export type {
  FrontmatterValue,
  InboxItem,
  ParseError,
  QueueStats,
  QueueResponse,
  QueueFilter,
} from "../commands/plugins/cross-team-queue/types";
