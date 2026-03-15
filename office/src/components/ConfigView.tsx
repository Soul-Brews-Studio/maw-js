import { memo, useState, useEffect, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
import { apiUrl } from "../lib/api";

interface ConfigFile {
  name: string;
  path: string;
  enabled: boolean;
}

export const ConfigView = memo(function ConfigView() {
  const [files, setFiles] = useState<ConfigFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: "ok" | "error"; msg: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const originalRef = useRef("");

  const loadFiles = useCallback(() => {
    fetch(apiUrl("/api/config-files"))
      .then((r) => r.json())
      .then((data) => setFiles(data.files || []))
      .catch(() => {});
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const loadFile = useCallback((path: string) => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    setSelected(path);
    setValue(null);
    setDirty(false);
    setStatus(null);
    fetch(apiUrl(`/api/config-file?path=${encodeURIComponent(path)}`))
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setStatus({ type: "error", msg: data.error }); return; }
        setValue(data.content);
        originalRef.current = data.content;
      })
      .catch((e) => setStatus({ type: "error", msg: e.message }));
  }, [dirty]);

  // Auto-select first file
  useEffect(() => {
    if (files.length > 0 && !selected) loadFile(files[0].path);
  }, [files, selected, loadFile]);

  const handleChange = useCallback((v: string | undefined) => {
    if (v === undefined) return;
    setValue(v);
    setDirty(v !== originalRef.current);
    setStatus(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!value || !selected) return;
    try { JSON.parse(value); } catch { setStatus({ type: "error", msg: "Invalid JSON" }); return; }
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(apiUrl(`/api/config-file?path=${encodeURIComponent(selected)}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: value }),
      });
      const data = await res.json();
      if (data.ok) {
        setStatus({ type: "ok", msg: "Saved" });
        setDirty(false);
        originalRef.current = value;
      } else {
        setStatus({ type: "error", msg: data.error || "Save failed" });
      }
    } catch (e: any) {
      setStatus({ type: "error", msg: e.message });
    } finally {
      setSaving(false);
    }
  }, [value, selected]);

  const handleToggle = useCallback(async (path: string) => {
    const res = await fetch(apiUrl(`/api/config-file/toggle?path=${encodeURIComponent(path)}`), { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      loadFiles();
      if (selected === path) setSelected(data.newPath);
    }
  }, [selected, loadFiles]);

  const handleDelete = useCallback(async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    const res = await fetch(apiUrl(`/api/config-file?path=${encodeURIComponent(path)}`), { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      loadFiles();
      if (selected === path) { setSelected(null); setValue(null); }
    }
  }, [selected, loadFiles]);

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return;
    const name = newName.endsWith(".json") ? newName : newName + ".json";
    const template = JSON.stringify({ name: name.replace(/\.json$/, ""), windows: [] }, null, 2);
    const res = await fetch(apiUrl(`/api/config-file`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content: template }),
    });
    const data = await res.json();
    if (data.ok) {
      setShowNew(false);
      setNewName("");
      loadFiles();
      loadFile(data.path);
    } else {
      setStatus({ type: "error", msg: data.error });
    }
  }, [newName, loadFiles, loadFile]);

  // Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty) handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [dirty, handleSave]);

  return (
    <div className="flex-1 flex min-h-0 mx-4 sm:mx-6 mb-3 rounded-2xl overflow-hidden border border-white/[0.06]">
      {/* Sidebar */}
      <div className="w-[220px] flex-shrink-0 flex flex-col border-r border-white/[0.06]" style={{ background: "#08080e" }}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
          <span className="text-[10px] font-mono text-white/30 tracking-[2px] uppercase">Files</span>
          <button
            onClick={() => setShowNew(true)}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded text-cyan-400/70 hover:text-cyan-400 transition-colors"
            title="New fleet file"
          >
            +
          </button>
        </div>

        {showNew && (
          <div className="px-3 py-2.5 border-b border-white/[0.06] flex gap-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowNew(false); }}
              className="flex-1 min-w-0 bg-transparent text-white/80 outline-none font-mono text-[11px] px-1.5 py-1 rounded border border-cyan-400/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-clear-button]:hidden [&::-ms-clear]:hidden"
              style={{ WebkitAppearance: "none" as const }}
              placeholder="filename.json"
              autoFocus
              spellCheck={false}
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {(() => {
            // Group: root configs, then fleet by session number prefix
            const root = files.filter(f => !f.path.startsWith("fleet/"));
            const fleet = files.filter(f => f.path.startsWith("fleet/"));
            const groups = new Map<string, ConfigFile[]>();
            for (const f of fleet) {
              const match = f.name.match(/^(\d+)-/);
              const key = match ? match[1] : "other";
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(f);
            }

            const renderFile = (f: ConfigFile, indented = false) => {
              const isSelected = selected === f.path;
              const isFleet = f.path.startsWith("fleet/");
              return (
                <div
                  key={f.path}
                  className="group flex items-center gap-2 py-1.5 cursor-pointer transition-colors"
                  style={{
                    background: isSelected ? "rgba(34,211,238,0.08)" : "transparent",
                    borderLeft: isSelected ? "2px solid #22d3ee" : "2px solid transparent",
                    paddingLeft: indented ? 26 : 12,
                    paddingRight: 12,
                  }}
                  onClick={() => loadFile(f.path)}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: f.enabled ? "#4caf50" : "#555" }}
                    title={f.enabled ? "Active" : "Disabled"}
                  />
                  <span
                    className="flex-1 min-w-0 text-[11px] font-mono truncate"
                    style={{ color: isSelected ? "#22d3ee" : f.enabled ? "#cdd6f4" : "#555" }}
                  >
                    {f.name.replace(/\.json(\.disabled)?$/, "")}
                  </span>
                  {isFleet && (
                    <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggle(f.path); }}
                        className="text-[9px] px-1 py-0.5 rounded hover:bg-white/5 transition-colors"
                        style={{ color: f.enabled ? "#ffa726" : "#4caf50" }}
                        title={f.enabled ? "Disable" : "Enable"}
                      >
                        {f.enabled ? "off" : "on"}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(f.path); }}
                        className="text-[9px] text-red-400/50 hover:text-red-400 px-1 py-0.5 rounded hover:bg-white/5 transition-colors"
                        title="Delete"
                      >
                        x
                      </button>
                    </div>
                  )}
                </div>
              );
            };

            return (
              <>
                {root.length > 0 && (
                  <>
                    <div className="px-3 pt-2 pb-1">
                      <span className="text-[9px] font-mono text-white/20 tracking-[2px] uppercase">Config</span>
                    </div>
                    {root.map(renderFile)}
                  </>
                )}
                {[...groups.entries()].map(([num, groupFiles]) => (
                  <div key={num}>
                    <div className="px-3 pt-3 pb-1 flex items-center gap-2">
                      <span className="text-[11px] font-mono text-cyan-400/40 tracking-[1px] font-bold">{num}</span>
                      <span className="text-[11px] font-mono text-white/30 truncate">
                        {groupFiles.map(f => f.name.replace(/\.json(\.disabled)?$/, "").replace(/^\d+-/, "")).join(", ")}
                      </span>
                      <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.06)" }} />
                      <span className="text-[11px] font-mono text-white/15">{groupFiles.filter(f => f.enabled).length}/{groupFiles.length}</span>
                    </div>
                    {groupFiles.map(f => renderFile(f, true))}
                  </div>
                ))}
              </>
            );
          })()}
        </div>
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/[0.06] flex-shrink-0" style={{ background: "#0a0a12" }}>
          <span className="text-xs font-mono text-white/40 truncate">{selected || "no file selected"}</span>
          {dirty && <span className="text-[10px] font-mono text-amber-400/70 px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.15)" }}>modified</span>}
          <div className="ml-auto flex items-center gap-2 flex-shrink-0">
            {status && (
              <span className="text-[11px] font-mono px-2 py-1 rounded" style={{ color: status.type === "ok" ? "#4caf50" : "#ef5350", background: status.type === "ok" ? "rgba(76,175,80,0.1)" : "rgba(239,83,80,0.1)" }}>
                {status.msg}
              </span>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="px-4 py-1.5 rounded-lg text-xs font-mono font-bold active:scale-95 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{
                background: dirty ? "rgba(34,211,238,0.15)" : "rgba(255,255,255,0.04)",
                color: dirty ? "#22d3ee" : "#555",
                border: `1px solid ${dirty ? "rgba(34,211,238,0.3)" : "rgba(255,255,255,0.06)"}`,
              }}
            >
              {saving ? "..." : "Save"}
            </button>
            <span className="text-[9px] font-mono text-white/20">^S</span>
          </div>
        </div>

        {/* Monaco */}
        <div className="flex-1 min-h-0">
          {value !== null ? (
            <Editor
              defaultLanguage="json"
              value={value}
              onChange={handleChange}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "'SF Mono', 'Fira Code', 'Courier New', monospace",
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                padding: { top: 12 },
                renderLineHighlight: "gutter",
                overviewRulerBorder: false,
                scrollbar: { verticalScrollbarSize: 6 },
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <span className="text-white/20 font-mono text-sm">
                {selected ? "Loading..." : "Select a file"}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
