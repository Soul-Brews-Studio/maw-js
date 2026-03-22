import { memo, useMemo, useState, useCallback, useRef, useEffect } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { HoverPreviewCard } from "./HoverPreviewCard";
import { Joystick } from "./Joystick";
import { OracleSearch } from "./OracleSearch";
import { BottomStats } from "./BottomStats";
import { FpsCounter } from "./FpsCounter";
import { roomStyle, PREVIEW_CARD } from "../lib/constants";
import { BroadcastModal } from "./FleetGrid";
import type { AgentState, Session, AgentEvent } from "../lib/types";
interface MissionControlProps {
  sessions: Session[];
  agents: AgentState[];
  connected: boolean;
  send: (msg: object) => void;
  onSelectAgent: (agent: AgentState) => void;
  eventLog: AgentEvent[];
  addEvent: (target: string, type: AgentEvent["type"], detail: string) => void;
}

export const MissionControl = memo(function MissionControl({
  sessions,
  agents,
  connected,
  send,
  onSelectAgent,
  eventLog,
  addEvent,
}: MissionControlProps) {
  const [groupSolo, setGroupSolo] = useState(true);
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{ agent: AgentState; room: { label: string; accent: string }; pos: { x: number; y: number } } | null>(null);
  const [pinnedPreview, setPinnedPreview] = useState<{ agent: AgentState; room: { label: string; accent: string }; pos: { x: number; y: number }; svgX: number; svgY: number } | null>(null);
  const pinnedByUser = useRef(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout>>();

  const [showSearch, setShowSearch] = useState(false);
  const [showBroadcast, setShowBroadcast] = useState(false);

  // Hide search when card is pinned
  useEffect(() => {
    if (pinnedPreview) setShowSearch(false);
  }, [pinnedPreview]);

  // Multi-card: track all busy agents, user can dismiss individually
  const [multiCards, setMultiCards] = useState<Set<string>>(new Set());
  const seenBusy = useRef<Set<string>>(new Set());
  useEffect(() => {
    const busyAgents = agents.filter(a => a.status === "busy");
    let changed = false;
    for (const a of busyAgents) {
      if (!seenBusy.current.has(a.target)) {
        seenBusy.current.add(a.target);
        setMultiCards(prev => new Set([...prev, a.target]));
        changed = true;
      }
    }
    // Clean up seen set when agents go idle
    for (const target of seenBusy.current) {
      if (!busyAgents.find(a => a.target === target)) seenBusy.current.delete(target);
    }
  }, [agents]);
  const dismissCard = useCallback((target: string) => {
    setMultiCards(prev => { const next = new Set(prev); next.delete(target); return next; });
  }, []);

  // Cmd+K or Ctrl+K to toggle search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch((s) => !s);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Auto-fit zoom: portrait = higher zoom (narrower), landscape = 0.9
  const [zoom, setZoom] = useState(() => {
    if (typeof window === "undefined") return 0.9;
    const isPortrait = window.innerHeight > window.innerWidth;
    return isPortrait ? 1.05 : 0.9;
  });
  const [pan, setPan] = useState({ x: 0, y: 120 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Convert SVG coordinates to screen-relative position
  const svgToScreen = useCallback((svgX: number, svgY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = svgX;
    pt.y = svgY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const screenPt = pt.matrixTransform(ctm);
    const containerRect = container.getBoundingClientRect();
    return {
      x: screenPt.x - containerRect.left,
      y: screenPt.y - containerRect.top,
    };
  }, []);

  // side: "right" (default/hover), "left", or "auto" (prefer right, fallback left)
  const calcCardPos = useCallback((svgX: number, svgY: number, side: "left" | "right" | "auto" = "auto") => {
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!containerRect) return { x: 0, y: 0 };
    const screen = svgToScreen(svgX, svgY);
    const cardW = PREVIEW_CARD.width;
    const cardH = 500;
    const rightX = screen.x + 60;
    const leftX = screen.x - cardW - 40;
    let x: number;
    if (side === "right") {
      x = rightX + cardW > containerRect.width ? leftX : rightX;
    } else if (side === "left") {
      x = leftX < 0 ? rightX : leftX;
    } else {
      x = rightX + cardW > containerRect.width ? leftX : rightX;
    }
    const y = Math.max(10, Math.min(screen.y - 290, containerRect.height - cardH - 20));
    return { x, y };
  }, [svgToScreen]);

  // Show preview card on hover — anchored to agent's SVG position (skip when pinned)
  const showPreview = useCallback((agent: AgentState, room: { label: string; accent: string }, svgX: number, svgY: number) => {
    if (pinnedPreview) return;
    clearTimeout(hoverTimeout.current);
    const pos = calcCardPos(svgX, svgY);
    setHoverPreview({ agent, room, pos });
  }, [calcCardPos, pinnedPreview]);

  const hidePreview = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setHoverPreview(null), 300);
  }, []);

  const keepPreview = useCallback(() => {
    clearTimeout(hoverTimeout.current);
  }, []);

  // Pan with middle mouse or drag
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 0 && e.shiftKey) {
      e.preventDefault();
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
    }
  }, [pan]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan({ x: panStart.current.panX + dx / zoom, y: panStart.current.panY + dy / zoom });
  }, [isPanning, zoom]);

  const onMouseUp = useCallback(() => setIsPanning(false), []);

  const resetView = useCallback(() => { setZoom(1.1); setPan({ x: 0, y: 0 }); }, []);

  const onJoystickPan = useCallback((dx: number, dy: number) => {
    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  // Group agents by session
  const sessionAgents = useMemo(() => {
    const map = new Map<string, AgentState[]>();
    for (const a of agents) {
      const arr = map.get(a.session) || [];
      arr.push(a);
      map.set(a.session, arr);
    }
    return map;
  }, [agents]);

  // Layout: optionally merge solo rooms into "Oracles" cluster, arrange in circle
  const layout = useMemo(() => {
    const sessionList = sessions.map((s) => ({
      session: s,
      agents: sessionAgents.get(s.name) || [],
      style: roomStyle(s.name),
    }));

    type LayoutItem = typeof sessionList[0];
    let virtual: LayoutItem[];

    if (groupSolo) {
      // Separate multi-agent rooms from solo rooms
      const multi = sessionList.filter(s => s.agents.length > 1);
      const soloAgents = sessionList.filter(s => s.agents.length === 1).flatMap(s => s.agents);

      virtual = [];
      if (soloAgents.length > 0) {
        virtual.push({
          session: { name: "_oracles", windows: [] },
          agents: soloAgents,
          style: { accent: "#7e57c2", floor: "#1a1428", wall: "#120e1e", label: "Oracles" },
        });
      }
      virtual.push(...multi);
    } else {
      virtual = sessionList;
    }

    const cx = 640, cy = 460;
    const radius = Math.min(370, 160 + virtual.length * 28);

    return virtual.map((s, i) => {
      const angle = (i / virtual.length) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      return { ...s, x, y };
    });
  }, [sessions, sessionAgents, groupSolo]);

  // Persistent input buffer per agent (survives pin/unpin)
  const [inputBufs, setInputBufs] = useState<Record<string, string>>({});
  const getInputBuf = useCallback((target: string) => inputBufs[target] || "", [inputBufs]);
  const setInputBuf = useCallback((target: string, val: string) => {
    setInputBufs(prev => ({ ...prev, [target]: val }));
  }, []);

  // Click agent -> pin preview card
  const onAgentClick = useCallback(
    (agent: AgentState, svgX: number, svgY: number, room: { label: string; accent: string }) => {
      if (pinnedPreview) {
        addEvent(agent.target, "command", `clicked ${agent.name}`);
        return;
      }
      const pos = calcCardPos(svgX, svgY);
      pinnedByUser.current = true;
      setPinnedPreview({ agent, room, pos, svgX, svgY });
      setHoverPreview(null);
      send({ type: "subscribe", target: agent.target });
    },
    [calcCardPos, send, pinnedPreview, addEvent]
  );

  // Fullscreen -> close pin first, then open modal
  const onPinnedFullscreen = useCallback(() => {
    if (pinnedPreview) {
      const agent = pinnedPreview.agent;
      setPinnedPreview(null);
      setTimeout(() => onSelectAgent(agent), 150);
    }
  }, [pinnedPreview, onSelectAgent]);

  const onPinnedClose = useCallback(() => {
    setPinnedPreview(null);
  }, []);

  const pinnedRef = useRef<HTMLDivElement>(null);

  // Animate pinned card from hover position to center
  const [pinnedAnimPos, setPinnedAnimPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (pinnedPreview) {
      setPinnedAnimPos({ left: pinnedPreview.pos.x, top: pinnedPreview.pos.y });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const containerW = containerRef.current?.getBoundingClientRect().width || 800;
          setPinnedAnimPos({ left: (containerW - PREVIEW_CARD.width) / 2, top: 20 });
        });
      });
    } else {
      setPinnedAnimPos(null);
    }
  }, [pinnedPreview]);

  // Click outside pinned card to close
  useEffect(() => {
    if (!pinnedPreview) return;
    const handler = (e: MouseEvent) => {
      if (pinnedRef.current && !pinnedRef.current.contains(e.target as Node)) {
        setPinnedPreview(null);
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handler); };
  }, [pinnedPreview]);

  // Build lookup: agent target -> { svgX, svgY, room style }
  const agentPositions = useMemo(() => {
    const map = new Map<string, { svgX: number; svgY: number; style: ReturnType<typeof roomStyle> }>();
    for (const s of layout) {
      const count = s.agents.length;
      s.agents.forEach((agent, ai) => {
        const angle = (ai / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2;
        const r = count === 1 ? 0 : Math.min(Math.max(70, 35 + count * 18) - 35, 35 + count * 6);
        map.set(agent.target, {
          svgX: s.x + Math.cos(angle) * r,
          svgY: s.y + Math.sin(angle) * r,
          style: s.style,
        });
      });
    }
    return map;
  }, [layout]);

  // Compute viewBox based on zoom and pan
  const isPortrait = typeof window !== "undefined" && window.innerHeight > window.innerWidth;
  const baseH = isPortrait ? 650 : 1000;
  const vbW = 1200 / zoom;
  const vbH = baseH / zoom;
  const vbX = (1200 - vbW) / 2 - pan.x;
  const vbY = (baseH - vbH) / 2 - pan.y + (isPortrait ? 250 : 0);

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden"
      style={{ background: "#020208", height: "calc(100vh - 60px)", cursor: isPanning ? "grabbing" : "default" }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* SVG Mission Control */}
      <svg
        ref={svgRef}
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <radialGradient id="mc-bg-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#1a1a3e" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#020208" stopOpacity={0} />
          </radialGradient>
          <filter id="mc-glow">
            <feGaussianBlur in="SourceGraphic" stdDeviation="8" />
          </filter>
        </defs>

        {/* Background glow */}
        <circle cx={600} cy={500} r={500} fill="url(#mc-bg-glow)" />

        {/* Grid lines */}
        {Array.from({ length: 13 }, (_, i) => (
          <line key={`vl-${i}`} x1={i * 100} y1={0} x2={i * 100} y2={1000}
            stroke="#ffffff" strokeWidth={0.3} opacity={0.03} />
        ))}
        {Array.from({ length: 11 }, (_, i) => (
          <line key={`hl-${i}`} x1={0} y1={i * 100} x2={1200} y2={i * 100}
            stroke="#ffffff" strokeWidth={0.3} opacity={0.03} />
        ))}

        {/* Orbital rings */}
        <circle cx={600} cy={500} r={150} fill="none" stroke="#26c6da" strokeWidth={0.5} opacity={0.08}
          strokeDasharray="4 8" />
        <circle cx={600} cy={500} r={300} fill="none" stroke="#7e57c2" strokeWidth={0.5} opacity={0.06}
          strokeDasharray="6 12" />
        <circle cx={600} cy={500} r={450} fill="none" stroke="#ffa726" strokeWidth={0.5} opacity={0.04}
          strokeDasharray="8 16" />

        {/* Center hub — busy (bright) + ready (grey) agents ON STAGE */}
        {(() => {
          const stageAgents = agents.filter(a => a.status === "busy" || a.status === "ready");
          const busyCount = stageAgents.filter(a => a.status === "busy").length;
          const hubR = Math.max(45, 30 + stageAgents.length * 25);
          const hasStage = stageAgents.length > 0;
          return (
            <>
              <circle cx={600} cy={500} r={hubR} fill="none" stroke={hasStage ? "#ffa726" : "#26c6da"} strokeWidth={hasStage ? 1.5 : 1} opacity={hasStage ? 0.3 : 0.15} />
              {!hasStage ? (
                <>
                  <circle cx={600} cy={500} r={7} fill="#26c6da" opacity={0.4} />
                  <text x={600} y={468} textAnchor="middle" fill="#26c6da" fontSize={12} opacity={0.5}
                    fontFamily="'SF Mono', monospace" letterSpacing={5}>MISSION CONTROL</text>
                </>
              ) : (
                <>
                  <text x={600} y={500 - hubR + 16} textAnchor="middle" fill="#ffa726" fontSize={10} opacity={0.7}
                    fontFamily="'SF Mono', monospace" letterSpacing={3}>ON STAGE</text>
                  <text x={600 + 38} y={500 - hubR + 17} textAnchor="start" fill="#ffa726" fontSize={9} opacity={0.5}
                    fontFamily="'SF Mono', monospace">{busyCount > 0 ? busyCount : ""}</text>
                  {stageAgents.map((a, i) => {
                    const cols = Math.min(stageAgents.length, 4);
                    const rows = Math.ceil(stageAgents.length / cols);
                    const col = i % cols;
                    const row = Math.floor(i / cols);
                    const spacing = 65;
                    const ax = 600 + (col - (cols - 1) / 2) * spacing;
                    const ay = 500 + (row - (rows - 1) / 2) * spacing;
                    const isBusy = a.status === "busy";
                    return (
                      <g key={a.target} transform={`translate(${ax},${ay})`} className="cursor-pointer"
                        style={{ opacity: isBusy ? 1 : 0.35, filter: isBusy ? "none" : "grayscale(1)", transition: "opacity 1s, filter 1s" }}
                        onClick={() => {
                          const room = roomStyle(a.session);
                          const pos = { x: window.innerWidth / 2 + 50, y: 80 };
                          pinnedByUser.current = true;
                          setPinnedPreview({ agent: a, room: { label: room.label, accent: room.accent }, pos, svgX: ax, svgY: ay });
                        }}>
                        <AgentAvatar name={a.name} target={a.target} status={a.status} preview="" accent={isBusy ? "#ffa726" : "#666"} onClick={() => {}} />
                      </g>
                    );
                  })}
                </>
              )}
            </>
          );
        })()}

        {/* Connection lines from hub to sessions */}
        {layout.map((s) => (
          <line key={`line-${s.session.name}`}
            x1={600} y1={500} x2={s.x} y2={s.y}
            stroke={s.style.accent} strokeWidth={0.5} opacity={0.08}
            strokeDasharray="2 6"
          />
        ))}

        {/* Session clusters */}
        {layout.map((s) => {
          const agentCount = s.agents.length;
          const clusterRadius = Math.max(70, 35 + agentCount * 18);
          const hasBusy = s.agents.some((a) => a.status === "busy");

          return (
            <g key={s.session.name}>
              {/* Session zone */}
              <circle cx={s.x} cy={s.y} r={clusterRadius}
                fill={`${s.style.floor}cc`}
                stroke={s.style.accent}
                strokeWidth={hasBusy ? 1.5 : 0.5}
                opacity={hasBusy ? 0.8 : 0.4}
                style={hasBusy ? { animation: "room-pulse 2s ease-in-out infinite" } : {}}
              />

              {/* Session label */}
              <text
                x={s.x} y={s.y - clusterRadius - 12}
                textAnchor="middle"
                fill={s.style.accent}
                fontSize={13}
                fontWeight="bold"
                fontFamily="'SF Mono', monospace"
                letterSpacing={3}
                opacity={0.8}
              >
                {s.style.label.toUpperCase()}
              </text>

              {/* Agent count badge */}
              <text
                x={s.x} y={s.y + clusterRadius + 18}
                textAnchor="middle"
                fill={s.style.accent}
                fontSize={10}
                fontFamily="'SF Mono', monospace"
                opacity={0.6}
              >
                {agentCount} agent{agentCount !== 1 ? "s" : ""}
              </text>

              {/* Agents within cluster */}
              {s.agents.map((agent, ai) => {
                const agentAngle = (ai / Math.max(1, agentCount)) * Math.PI * 2 - Math.PI / 2;
                const agentRadius = agentCount === 1 ? 0 : Math.min(clusterRadius - 35, 35 + agentCount * 6);
                const ax = s.x + Math.cos(agentAngle) * agentRadius;
                const ay = s.y + Math.sin(agentAngle) * agentRadius;
                const isHovered = hoveredAgent === agent.target;
                const scale = isHovered ? 1.4 : 0.65;

                return (
                  <g key={agent.target} transform={`translate(${ax}, ${ay})`}
                    style={{ zIndex: isHovered ? 999 : 0 }}
                  >
                    {/* Hover backdrop glow */}
                    {isHovered && (
                      <circle cx={0} cy={-5} r={55} fill={s.style.accent} opacity={0.08} />
                    )}
                    <g
                      transform={`scale(${scale})`}
                      onMouseEnter={() => {
                        setHoveredAgent(agent.target);
                        showPreview(agent, { label: s.style.label, accent: s.style.accent }, ax, ay);
                      }}
                      onMouseLeave={() => {
                        setHoveredAgent(null);
                        hidePreview();
                      }}
                      style={{ transition: "transform 0.15s ease-out" }}
                    >
                      <AgentAvatar
                        name={agent.name}
                        target={agent.target}
                        status={agent.status}
                        preview={agent.preview}
                        accent={s.style.accent}
                        onClick={() => onAgentClick(agent, ax, ay, { label: s.style.label, accent: s.style.accent })}
                      />
                    </g>
                    {/* Agent name (below) */}
                    <text
                      y={28}
                      textAnchor="middle"
                      fill={isHovered ? s.style.accent : "#ffffff"}
                      fontSize={isHovered ? 11 : 9}
                      fontFamily="'SF Mono', monospace"
                      opacity={isHovered ? 1 : 0.7}
                      style={{ transition: "all 0.2s", cursor: "pointer" }}
                      onClick={() => onAgentClick(agent, ax, ay, { label: s.style.label, accent: s.style.accent })}
                    >
                      {agent.name.replace(/-oracle$/, "").replace(/-/g, " ")}
                    </text>

                    {/* Hover tooltip — hidden when preview card is showing */}
                    {isHovered && !hoverPreview && (
                      <g>
                        <rect x={-100} y={-65} width={200} height={34} rx={8}
                          fill="rgba(8,8,16,0.95)" stroke={s.style.accent} strokeWidth={0.8} opacity={0.95} />
                        {agent.preview && (
                          <text x={0} y={-48} textAnchor="middle" fill="#e0e0e0" fontSize={9}
                            fontFamily="'SF Mono', monospace">
                            {agent.preview.slice(0, 35)}
                          </text>
                        )}
                        <text x={0} y={-38} textAnchor="middle" fill={s.style.accent} fontSize={8}
                          fontFamily="'SF Mono', monospace" opacity={0.7}>
                          {agent.status} · {agent.target}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Controls — bottom right: pan + zoom + group toggle */}
      <div className="absolute bottom-4 right-6 flex flex-col items-center gap-1">
        <button
          onClick={() => setGroupSolo(g => !g)}
          className="w-8 h-8 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-[9px] text-white/50 hover:text-white hover:bg-white/10 cursor-pointer font-mono"
          title={groupSolo ? "Show all rooms" : "Group solo oracles"}
        >
          {groupSolo ? "G" : "A"}
        </button>
        <div className="w-6 border-t border-white/[0.06] my-0.5" />
        <Joystick onPan={onJoystickPan} />
        <div className="w-6 border-t border-white/[0.06] my-0.5" />
        <button onClick={() => setZoom((z) => Math.min(3, z + 0.05))}
          className="w-8 h-8 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-white/70 hover:text-white hover:bg-white/10 text-lg font-bold cursor-pointer">+</button>
        <button onClick={resetView}
          className="w-8 h-6 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-[9px] text-white/50 hover:text-white hover:bg-white/10 cursor-pointer font-mono">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.05))}
          className="w-8 h-8 rounded-lg bg-black/50 backdrop-blur border border-white/10 text-white/70 hover:text-white hover:bg-white/10 text-lg font-bold cursor-pointer">−</button>
      </div>

      {/* Hover Preview Card — manual hover (hidden when pinned) */}
      {hoverPreview && !pinnedPreview && (
        <div
          className="absolute z-30 pointer-events-auto"
          style={{
            left: hoverPreview.pos.x,
            top: hoverPreview.pos.y,
            maxWidth: PREVIEW_CARD.width,
            animation: "fadeSlideIn 0.15s ease-out",
          }}
          onMouseEnter={keepPreview}
          onMouseLeave={hidePreview}
        >
          <HoverPreviewCard
            agent={hoverPreview.agent}
            roomLabel={hoverPreview.room.label}
            accent={hoverPreview.room.accent}
          />
        </div>
      )}

      {/* Pinned Preview Card — single agent (from click) */}
      {pinnedPreview && pinnedAnimPos && (
        <div
          ref={pinnedRef}
          className="absolute z-40 pointer-events-auto"
          style={{
            left: pinnedAnimPos.left,
            top: pinnedAnimPos.top,
            maxWidth: PREVIEW_CARD.width,
            transition: "left 0.3s ease-out, top 0.3s ease-out",
          }}
        >
          <HoverPreviewCard
            agent={pinnedPreview.agent}
            roomLabel={pinnedPreview.room.label}
            accent={pinnedPreview.room.accent}
            pinned
            send={send}
            onFullscreen={onPinnedFullscreen}
            onClose={onPinnedClose}
            eventLog={eventLog}
            addEvent={addEvent}
            externalInputBuf={getInputBuf(pinnedPreview.agent.target)}
            onInputBufChange={(val) => setInputBuf(pinnedPreview.agent.target, val)}
          />
        </div>
      )}

      {/* Multi-card bar — all busy agents side by side */}
      {multiCards.size > 0 && !pinnedPreview && (
        <div className="absolute bottom-16 left-4 right-20 z-35 flex gap-2 overflow-x-auto pointer-events-auto" style={{ scrollbarWidth: "none" }}>
          {[...multiCards].map(target => {
            const agent = agents.find(a => a.target === target);
            if (!agent) return null;
            const room = roomStyle(agent.session);
            return (
              <div key={target} style={{ flex: 1, minWidth: 280 }}>
                <HoverPreviewCard
                  agent={agent}
                  roomLabel={room.label}
                  accent={room.accent}
                  pinned
                  send={send}
                  onClose={() => dismissCard(target)}
                  eventLog={eventLog}
                  addEvent={addEvent}
                  externalInputBuf={getInputBuf(target)}
                  onInputBufChange={(val) => setInputBuf(target, val)}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom left buttons — search + broadcast */}
      <div className="absolute bottom-4 left-6 flex items-center gap-2 z-20">
        <button
          onClick={() => setShowSearch(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/50 backdrop-blur border border-white/10 text-white/50 hover:text-[#64b5f6] hover:border-[#64b5f6]/30 cursor-pointer transition-all"
          title="Search Oracle (⌘K)"
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <circle cx={11} cy={11} r={8} />
            <line x1={21} y1={21} x2={16.65} y2={16.65} />
          </svg>
          <span className="text-[10px] font-mono">Oracle</span>
          <kbd className="text-[8px] text-white/20 ml-1">⌘K</kbd>
        </button>
      </div>

      {/* Oracle Search overlay */}
      {showSearch && <OracleSearch onClose={() => setShowSearch(false)} />}

      {/* Bottom stats + FPS */}
      <BottomStats agents={agents} />
      <FpsCounter />
    </div>
  );
});
