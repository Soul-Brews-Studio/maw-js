import { useState, useCallback, useEffect, useRef } from "react";
import { apiUrl } from "../lib/api";

const STORAGE_KEY = "office-unlocked";

export function PinLock({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(STORAGE_KEY) === "1");
  const [pinLength, setPinLength] = useState(4);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [digits, setDigits] = useState<string[]>([]);
  const [error, setError] = useState(false);

  // Fetch PIN config from server
  useEffect(() => {
    if (unlocked) return;
    fetch(apiUrl("/api/pin-info"))
      .then(r => r.json())
      .then(data => {
        setPinLength(data.length || 4);
        setEnabled(data.enabled);
        if (!data.enabled) {
          sessionStorage.setItem(STORAGE_KEY, "1");
          setUnlocked(true);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [unlocked]);

  const handleDigit = useCallback((d: string) => {
    setError(false);
    setDigits(prev => {
      const next = [...prev, d];
      if (next.length === pinLength) {
        // Verify server-side
        fetch(apiUrl("/api/pin-verify"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: next.join("") }),
        })
          .then(r => r.json())
          .then(data => {
            if (data.ok) {
              sessionStorage.setItem(STORAGE_KEY, "1");
              setUnlocked(true);
            } else {
              setError(true);
              setTimeout(() => { setDigits([]); setError(false); }, 500);
            }
          })
          .catch(() => {
            setError(true);
            setTimeout(() => { setDigits([]); setError(false); }, 500);
          });
      }
      return next.length > pinLength ? [] : next;
    });
  }, [pinLength]);

  const handleDelete = useCallback(() => {
    setDigits(prev => prev.slice(0, -1));
    setError(false);
  }, []);

  // Keyboard support
  useEffect(() => {
    if (unlocked) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") handleDigit(e.key);
      else if (e.key === "Backspace") handleDelete();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [unlocked, handleDigit, handleDelete]);

  if (unlocked) return <>{children}</>;
  if (loading) return <div className="fixed inset-0" style={{ background: "#020208" }} />;

  const BUTTONS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center" style={{ background: "#020208" }}>
      <div className="mb-8 text-center">
        <h1 className="text-4xl text-cyan-400">ψ</h1>
        <p className="text-xs text-white/20 mt-2 font-mono">Enter PIN</p>
      </div>

      {/* PIN dots */}
      <div className="flex gap-4 mb-10">
        {Array.from({ length: pinLength }).map((_, i) => (
          <div
            key={i}
            className="w-4 h-4 rounded-full transition-all duration-150"
            style={{
              background: error
                ? "#ef4444"
                : i < digits.length
                  ? "#22d3ee"
                  : "rgba(255,255,255,0.1)",
              boxShadow: i < digits.length && !error ? "0 0 8px rgba(34,211,238,0.5)" : "none",
              transform: error ? `translateX(${(i % 2 === 0 ? 4 : -4)}px)` : "none",
            }}
          />
        ))}
      </div>

      {/* Number pad */}
      <div className="grid grid-cols-3 gap-3" style={{ width: 240 }}>
        {BUTTONS.map((btn, i) => {
          if (btn === "") return <div key={i} />;
          if (btn === "⌫") {
            return (
              <button
                key={i}
                onClick={handleDelete}
                className="h-16 rounded-2xl flex items-center justify-center text-lg text-white/40 cursor-pointer active:scale-90 transition-all"
                style={{ background: "rgba(255,255,255,0.04)" }}
              >
                ⌫
              </button>
            );
          }
          return (
            <button
              key={i}
              onClick={() => handleDigit(btn)}
              className="h-16 rounded-2xl flex items-center justify-center text-xl font-medium text-white/80 cursor-pointer active:scale-90 transition-all hover:bg-white/[0.08]"
              style={{ background: "rgba(255,255,255,0.05)" }}
            >
              {btn}
            </button>
          );
        })}
      </div>
    </div>
  );
}
