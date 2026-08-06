/**
 * `maw ui` — barrel re-export.
 *
 * @see impl-helpers.ts  — pure helpers (peer resolution, URL/tunnel builders)
 * @see impl-render.ts   — output rendering, arg parsing, cmdUi dispatcher
 */

export type { UiOptions } from "./impl-helpers";
export {
  resolvePeerHostPort,
  justHost,
  isUiDistInstalled,
  findMawUiSrcDir,
  buildDevCommand,
  buildLensUrl,
  buildTunnelCommand,
  LENS_PORT,
  MAW_PORT,
  LENS_PAGE_2D,
  LENS_PAGE_3D,
} from "./impl-helpers";
export { renderUiOutput, parseUiArgs, cmdUi } from "./impl-render";
