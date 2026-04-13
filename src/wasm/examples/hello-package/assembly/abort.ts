export function abort(
  message: string | null,
  fileName: string | null,
  lineNumber: u32,
  columnNumber: u32,
): void {
  // noop — maw plugins provide abort via env; override here to avoid dangling import
}
