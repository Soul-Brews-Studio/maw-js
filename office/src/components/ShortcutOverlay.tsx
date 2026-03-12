import { memo, useEffect } from "react";

interface ShortcutOverlayProps {
  onClose: () => void;
}

const SHORTCUTS = [
  ["Navigation", [
    ["?", "Show shortcuts"],
    ["Scroll", "Zoom in/out"],
    ["Shift+Drag", "Pan view"],
    ["Joystick", "Drag to pan"],
  ]],
  ["Views", [
    ["V", "VS view"],
  ]],
  ["Pinned Card", [
    ["Click agent", "Pin card + input"],
    ["Enter", "Send command"],
    ["Ctrl+Enter", "Fullscreen"],
    ["Esc", "Close card"],
    ["Click outside", "Close card"],
  ]],
  ["Fullscreen Terminal", [
    ["Enter", "Send command"],
    ["Esc", "Close"],
    ["Alt+←/→", "Prev/next agent"],
    ["Alt+1-9", "Jump to agent"],
    ["Ctrl+C", "Clear input"],
  ]],
] as const;

export const ShortcutOverlay = memo(function ShortcutOverlay({ onClose }: ShortcutOverlayProps) {
  // Capture Escape/Enter at window level, stop propagation so nothing underneath reacts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.stopPropagation();
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true); // capture phase
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="rounded-xl border border-white/[0.08] p-6 max-w-md w-full"
        style={{ background: "#0a0a0f" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-center text-white/60 text-xs tracking-[4px] uppercase font-mono mb-5">Keyboard Shortcuts</h2>

        <div className="flex flex-col gap-5">
          {SHORTCUTS.map(([section, keys]) => (
            <div key={section as string}>
              <h3 className="text-[10px] text-cyan-400/60 tracking-[3px] uppercase font-mono mb-2">{section as string}</h3>
              <div className="flex flex-col gap-1.5">
                {(keys as readonly (readonly [string, string])[]).map(([key, desc]) => (
                  <div key={key} className="flex items-center gap-3">
                    <kbd className="shrink-0 min-w-[90px] text-right px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-[11px] text-white/70 font-mono">
                      {key}
                    </kbd>
                    <span className="text-[11px] text-white/40 font-mono">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-center gap-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-white/[0.06] border border-white/[0.08] text-[11px] text-white/50 hover:text-white/80 hover:bg-white/10 cursor-pointer font-mono transition-colors"
          >
            Esc · Close
          </button>
        </div>
      </div>
    </div>
  );
});
