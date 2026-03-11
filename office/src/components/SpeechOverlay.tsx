import { memo, useState, useRef, useEffect, useCallback } from "react";
import { roomStyle } from "../lib/constants";

function createRecognition(): any | null {
  const W = window as any;
  const Ctor = W.SpeechRecognition || W.webkitSpeechRecognition;
  if (!Ctor) return null;
  return new Ctor();
}

interface SpeechOverlayProps {
  target: string;
  agentName?: string;
  agentSession?: string;
  send: (msg: object) => void;
  onClose: () => void;
}

export const SpeechOverlay = memo(function SpeechOverlay({
  target, agentName, agentSession, send, onClose,
}: SpeechOverlayProps) {
  const rs = agentSession ? roomStyle(agentSession) : { accent: "#fbbf24" };
  const displayName = agentName?.replace(/-oracle$/, "").replace(/-/g, " ") || target;

  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [micFailed, setMicFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const recRef = useRef<any>(null);

  const doSend = useCallback((msg: string) => {
    if (!msg.trim()) return;
    send({ type: "send", target, text: msg.trim() });
    setTimeout(() => send({ type: "send", target, text: "\r" }), 50);
    setSent(true);
    setTimeout(() => onClose(), 1000);
  }, [target, send, onClose]);

  // Auto-start speech recognition on mount
  useEffect(() => {
    const rec = createRecognition();
    if (!rec) {
      setMicFailed(true);
      setTimeout(() => inputRef.current?.focus(), 200);
      return;
    }

    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "th-TH";

    let finalText = "";

    rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (final) finalText = final;
      setTranscript(final || interim);
    };

    rec.onend = () => {
      setListening(false);
      if (finalText.trim()) {
        doSend(finalText);
      } else {
        // No speech detected — show text input
        setMicFailed(true);
        setTimeout(() => inputRef.current?.focus(), 200);
      }
    };

    rec.onerror = (e: any) => {
      console.warn("Speech error:", e.error);
      setListening(false);
      setMicFailed(true);
      setTimeout(() => inputRef.current?.focus(), 200);
    };

    recRef.current = rec;
    setListening(true);
    try { rec.start(); } catch {
      setListening(false);
      setMicFailed(true);
      setTimeout(() => inputRef.current?.focus(), 200);
    }

    return () => {
      try { rec.abort(); } catch {}
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopMic = useCallback(() => {
    try { recRef.current?.stop(); } catch {}
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center"
      style={{ background: "rgba(0,0,0,0.9)", backdropFilter: "blur(8px)" }}
      onClick={(e) => { if (e.target === e.currentTarget && !listening) onClose(); }}
    >
      {/* Agent identity */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-4 h-4 rounded-full" style={{ background: rs.accent, boxShadow: `0 0 12px ${rs.accent}` }} />
        <span className="text-xl font-semibold" style={{ color: rs.accent }}>{displayName}</span>
      </div>

      {/* Mic active state */}
      {listening && (
        <>
          <div className="relative w-44 h-44 mb-6" onClick={stopMic}>
            <div className="absolute inset-0 rounded-full animate-ping" style={{ background: `${rs.accent}10`, animationDuration: "1.5s" }} />
            <div className="absolute inset-4 rounded-full animate-ping" style={{ background: `${rs.accent}15`, animationDuration: "1.2s" }} />
            <div
              className="absolute inset-8 rounded-full flex items-center justify-center cursor-pointer active:scale-90 transition-transform"
              style={{ background: rs.accent, boxShadow: `0 0 60px ${rs.accent}80` }}
            >
              <svg width={44} height={44} viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect x={9} y={1} width={6} height={11} rx={3} />
                <path d="M19 10v1a7 7 0 01-14 0v-1M12 18v4M8 22h8" />
              </svg>
            </div>
          </div>

          {/* Live transcript */}
          <div className="px-10 text-center min-h-[2em] max-w-md mb-4">
            <p className="text-white/80 text-lg leading-relaxed">{transcript || "Listening..."}</p>
          </div>

          <p className="text-white/15 text-[12px] font-mono">Tap mic to send</p>
        </>
      )}

      {/* Text input fallback or after mic done */}
      {!listening && !sent && (
        <div className="w-full max-w-md px-6">
          {micFailed && (
            <p className="text-white/30 text-[12px] font-mono text-center mb-4">
              {transcript ? "Edit and send:" : "Type or use keyboard dictation 🎤"}
            </p>
          )}

          <div className="flex items-center gap-3">
            <input
              ref={inputRef}
              type="text"
              value={text || transcript}
              onChange={e => { setText(e.target.value); setTranscript(""); }}
              onKeyDown={e => { if (e.key === "Enter") doSend(text || transcript); if (e.key === "Escape") onClose(); }}
              placeholder="Speak or type..."
              className="flex-1 px-5 py-4 rounded-2xl text-[16px] text-white outline-none placeholder:text-white/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
              style={{
                background: "rgba(255,255,255,0.08)",
                border: `1px solid ${rs.accent}30`,
                WebkitAppearance: "none" as const,
              }}
              enterKeyHint="send"
              autoComplete="off"
              autoCorrect="off"
            />
            <button
              className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 cursor-pointer transition-all active:scale-90"
              style={{
                background: (text || transcript).trim() ? rs.accent : `${rs.accent}20`,
                boxShadow: (text || transcript).trim() ? `0 0 16px ${rs.accent}60` : "none",
              }}
              onClick={() => doSend(text || transcript)}
            >
              <svg width={22} height={22} viewBox="0 0 24 24" fill="none"
                stroke={(text || transcript).trim() ? "#000" : `${rs.accent}60`}
                strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Sent toast */}
      {sent && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-full flex items-center justify-center" style={{ background: "#22C55E25" }}>
            <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="#22C55E" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5L20 7" />
            </svg>
          </div>
          <span className="text-[14px] font-mono" style={{ color: "#22C55E" }}>Sent to {displayName}</span>
        </div>
      )}

      {/* Close hint */}
      {!listening && !sent && (
        <p className="mt-8 text-white/10 text-[11px] font-mono">Tap outside to close</p>
      )}
    </div>
  );
});
