/**
 * @maw-js/sdk/plugin — plugin-authoring types.
 *
 *   import type { InvokeContext, InvokeResult } from "@maw-js/sdk/plugin";
 *
 *   export default async function (ctx: InvokeContext): Promise<InvokeResult> {
 *     return { ok: true, output: "hello" };
 *   }
 */

export type { InvokeContext, InvokeResult } from "../../src/plugin/types";
