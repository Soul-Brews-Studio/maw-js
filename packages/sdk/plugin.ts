/**
 * @maw-js/sdk/plugin — plugin-authoring surface.
 *
 * Single import line for plugin authors:
 *
 *   import {
 *     type InvokeContext,
 *     type InvokeResult,
 *     UserError,
 *     isUserError,
 *     parseFlags,
 *   } from "@maw-js/sdk/plugin";
 *
 *   export default async function (ctx: InvokeContext): Promise<InvokeResult> {
 *     if (!ctx.args) throw new UserError("missing args");
 *     return { ok: true, output: "hello" };
 *   }
 *
 * Pure re-exports — semantics match the originals in src/. See #844 / #848:
 * shellenv inlined UserError + parseFlags as TEMP at v0.1.0; once this lands
 * those inlines disappear in v0.2.0. Same shape unblocks `maw-bg` and any
 * future plugin that needs user-facing exits or permissive flag parsing.
 */

export type { InvokeContext, InvokeResult } from "../../src/plugin/types";

export { UserError, isUserError } from "../../src/core/util/user-error";

export { parseFlags } from "../../src/cli/parse-args";
