/**
 * Compatibility re-export for the peer discovery client.
 *
 * The shared client lives in core command helpers so other plugins can reuse it
 * without depending on this vendored peers plugin directory.
 */
export * from "maw-js/commands/shared/discovered-peers-client";
