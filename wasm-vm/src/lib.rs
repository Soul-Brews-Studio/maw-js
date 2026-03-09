use wasm_bindgen::prelude::*;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;

// --- Data types (serialized to JS via serde-wasm-bindgen) ---

#[derive(Clone, Serialize, Deserialize)]
pub struct Agent {
    pub target: String,        // "session:windowIndex"
    pub name: String,          // window name
    pub session: String,       // tmux session = room
    pub window_index: u32,
    pub active: bool,
    pub preview: String,       // last line of terminal (120 chars max)
    pub status: String,        // "busy" | "ready" | "idle"
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Room {
    pub name: String,
    pub agents: Vec<Agent>,
    pub busy_count: u32,
    pub ready_count: u32,
    pub idle_count: u32,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FeedEvent {
    pub time: f64,             // js timestamp (ms)
    pub target: String,
    pub event_type: String,    // "status" | "command" | "saiyan"
    pub detail: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Stats {
    pub total_agents: u32,
    pub busy: u32,
    pub ready: u32,
    pub idle: u32,
    pub rooms: u32,
    pub saiyan_targets: Vec<String>,
}

// --- Internal state per agent ---

struct AgentInternal {
    target: String,
    name: String,
    session: String,
    window_index: u32,
    active: bool,
    content_hash: u64,
    last_change_time: f64,     // when content last changed
    status: AgentStatus,
    preview: String,
}

#[derive(Clone, Copy, PartialEq)]
enum AgentStatus {
    Busy,
    Ready,
    Idle,
}

impl AgentStatus {
    fn as_str(&self) -> &'static str {
        match self {
            AgentStatus::Busy => "busy",
            AgentStatus::Ready => "ready",
            AgentStatus::Idle => "idle",
        }
    }
}

// --- Busy indicators ---

const BUSY_INDICATORS: &[&str] = &[
    "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", // spinners
    "● Read", "● Edit", "● Write", "● Bash", "● Grep", "● Glob",
    "● Agent", "● WebFetch", "● WebSearch", "● Skill",
    "● ToolSearch", "● NotebookEdit",
    "◐", "◑", "◒", "◓", // alt spinners
];

const PROMPT_INDICATOR: &str = "❯";

// --- The VM Engine ---

#[wasm_bindgen]
pub struct OfficeVM {
    agents: HashMap<String, AgentInternal>,
    feed: Vec<FeedEvent>,
    feed_max: usize,
    saiyan_targets: Vec<String>,
    saiyan_max: usize,
}

#[wasm_bindgen]
impl OfficeVM {
    #[wasm_bindgen(constructor)]
    pub fn new() -> OfficeVM {
        OfficeVM {
            agents: HashMap::new(),
            feed: Vec::new(),
            feed_max: 200,
            saiyan_targets: Vec::new(),
            saiyan_max: 3,
        }
    }

    /// Update session tree. Called when WebSocket sends session list.
    /// sessions_json: [{ name: string, windows: [{ index, name, active }] }]
    pub fn update_sessions(&mut self, sessions_json: JsValue) -> Result<(), JsValue> {
        let sessions: Vec<SessionInput> = serde_wasm_bindgen::from_value(sessions_json)?;
        let now = js_sys::Date::now();

        // Track which targets we've seen
        let mut seen = std::collections::HashSet::new();

        for session in &sessions {
            for window in &session.windows {
                let target = format!("{}:{}", session.name, window.index);
                seen.insert(target.clone());

                self.agents.entry(target.clone()).or_insert_with(|| AgentInternal {
                    target: target.clone(),
                    name: window.name.clone(),
                    session: session.name.clone(),
                    window_index: window.index,
                    active: window.active,
                    content_hash: 0,
                    last_change_time: now,
                    status: AgentStatus::Idle,
                    preview: String::new(),
                });

                // Update metadata that can change
                if let Some(agent) = self.agents.get_mut(&target) {
                    agent.name = window.name.clone();
                    agent.active = window.active;
                    agent.session = session.name.clone();
                }
            }
        }

        // Remove agents no longer in session tree
        self.agents.retain(|k, _| seen.contains(k));
        self.saiyan_targets.retain(|t| seen.contains(t));

        Ok(())
    }

    /// Push capture content for a specific agent. The VM processes it
    /// and updates status/preview.
    pub fn push_capture(&mut self, target: &str, content: &str) {
        let now = js_sys::Date::now();
        let hash = simple_hash(content);

        if let Some(agent) = self.agents.get_mut(target) {
            let content_changed = hash != agent.content_hash;
            if content_changed {
                agent.content_hash = hash;
                agent.last_change_time = now;
            }

            agent.preview = extract_preview(content);

            let old_status = agent.status;
            agent.status = detect_status(content, content_changed, now, agent.last_change_time);

            // Extract what we need before releasing the borrow
            let agent_name = agent.name.clone();
            let new_status = agent.status;

            // Saiyan detection: transition to busy
            if old_status != AgentStatus::Busy && new_status == AgentStatus::Busy {
                self.add_saiyan(target);
                self.add_feed_event(now, target, "saiyan", &format!("{} powered up", agent_name));
            }

            // Status change event
            if old_status != new_status {
                self.add_feed_event(
                    now,
                    target,
                    "status",
                    &format!("{}: {} → {}", agent_name, old_status.as_str(), new_status.as_str()),
                );
            }
        }
    }

    /// Log a command sent to an agent
    pub fn log_command(&mut self, target: &str, text: &str) {
        let now = js_sys::Date::now();
        let name = self.agents.get(target).map(|a| a.name.clone()).unwrap_or_default();
        self.add_feed_event(now, target, "command", &format!("{}: {}", name, text));
    }

    // --- Getters (return JS values via serde) ---

    /// Get all agents as array
    pub fn get_agents(&self) -> Result<JsValue, JsValue> {
        let agents: Vec<Agent> = self.agents.values().map(|a| Agent {
            target: a.target.clone(),
            name: a.name.clone(),
            session: a.session.clone(),
            window_index: a.window_index,
            active: a.active,
            preview: a.preview.clone(),
            status: a.status.as_str().to_string(),
        }).collect();
        Ok(serde_wasm_bindgen::to_value(&agents)?)
    }

    /// Get agents grouped by room (session)
    pub fn get_rooms(&self) -> Result<JsValue, JsValue> {
        let mut rooms_map: HashMap<String, Vec<&AgentInternal>> = HashMap::new();
        for agent in self.agents.values() {
            rooms_map.entry(agent.session.clone()).or_default().push(agent);
        }

        let rooms: Vec<Room> = rooms_map.into_iter().map(|(name, agents)| {
            let mut busy = 0u32;
            let mut ready = 0u32;
            let mut idle = 0u32;
            let agent_list: Vec<Agent> = agents.iter().map(|a| {
                match a.status {
                    AgentStatus::Busy => busy += 1,
                    AgentStatus::Ready => ready += 1,
                    AgentStatus::Idle => idle += 1,
                }
                Agent {
                    target: a.target.clone(),
                    name: a.name.clone(),
                    session: a.session.clone(),
                    window_index: a.window_index,
                    active: a.active,
                    preview: a.preview.clone(),
                    status: a.status.as_str().to_string(),
                }
            }).collect();
            Room { name, agents: agent_list, busy_count: busy, ready_count: ready, idle_count: idle }
        }).collect();

        Ok(serde_wasm_bindgen::to_value(&rooms)?)
    }

    /// Get activity feed (most recent first)
    pub fn get_feed(&self, limit: Option<u32>) -> Result<JsValue, JsValue> {
        let n = limit.unwrap_or(50) as usize;
        let feed: Vec<&FeedEvent> = self.feed.iter().rev().take(n).collect();
        Ok(serde_wasm_bindgen::to_value(&feed)?)
    }

    /// Get summary stats
    pub fn get_stats(&self) -> Result<JsValue, JsValue> {
        let mut busy = 0u32;
        let mut ready = 0u32;
        let mut idle = 0u32;
        let mut sessions = std::collections::HashSet::new();

        for agent in self.agents.values() {
            match agent.status {
                AgentStatus::Busy => busy += 1,
                AgentStatus::Ready => ready += 1,
                AgentStatus::Idle => idle += 1,
            }
            sessions.insert(&agent.session);
        }

        let stats = Stats {
            total_agents: self.agents.len() as u32,
            busy,
            ready,
            idle,
            rooms: sessions.len() as u32,
            saiyan_targets: self.saiyan_targets.clone(),
        };
        Ok(serde_wasm_bindgen::to_value(&stats)?)
    }

    /// Get status for a single agent
    pub fn get_status(&self, target: &str) -> String {
        self.agents.get(target).map(|a| a.status.as_str().to_string()).unwrap_or_default()
    }

    /// Get preview for a single agent
    pub fn get_preview(&self, target: &str) -> String {
        self.agents.get(target).map(|a| a.preview.clone()).unwrap_or_default()
    }

    /// Get current saiyan (powered-up) targets
    pub fn get_saiyan_targets(&self) -> Result<JsValue, JsValue> {
        Ok(serde_wasm_bindgen::to_value(&self.saiyan_targets)?)
    }

    /// Dismiss a saiyan target
    pub fn dismiss_saiyan(&mut self, target: &str) {
        self.saiyan_targets.retain(|t| t != target);
    }

    /// Filter agents by status
    pub fn filter_by_status(&self, status: &str) -> Result<JsValue, JsValue> {
        let target_status = match status {
            "busy" => AgentStatus::Busy,
            "ready" => AgentStatus::Ready,
            "idle" => AgentStatus::Idle,
            _ => return Ok(serde_wasm_bindgen::to_value(&Vec::<Agent>::new())?),
        };

        let filtered: Vec<Agent> = self.agents.values()
            .filter(|a| a.status == target_status)
            .map(|a| Agent {
                target: a.target.clone(),
                name: a.name.clone(),
                session: a.session.clone(),
                window_index: a.window_index,
                active: a.active,
                preview: a.preview.clone(),
                status: a.status.as_str().to_string(),
            })
            .collect();

        Ok(serde_wasm_bindgen::to_value(&filtered)?)
    }

    // --- Internal helpers ---

    fn add_saiyan(&mut self, target: &str) {
        if !self.saiyan_targets.contains(&target.to_string()) {
            self.saiyan_targets.push(target.to_string());
            // FIFO: remove oldest if over limit
            while self.saiyan_targets.len() > self.saiyan_max {
                self.saiyan_targets.remove(0);
            }
        }
    }

    fn add_feed_event(&mut self, time: f64, target: &str, event_type: &str, detail: &str) {
        self.feed.push(FeedEvent {
            time,
            target: target.to_string(),
            event_type: event_type.to_string(),
            detail: detail.to_string(),
        });
        // Trim feed
        if self.feed.len() > self.feed_max {
            self.feed.drain(0..self.feed.len() - self.feed_max);
        }
    }
}

// --- Input types (for deserialization from JS) ---

#[derive(Deserialize)]
struct SessionInput {
    name: String,
    windows: Vec<WindowInput>,
}

#[derive(Deserialize)]
struct WindowInput {
    index: u32,
    name: String,
    active: bool,
}

// --- Pure functions ---

/// Status detection heuristic (mirrors useSessions.ts logic)
fn detect_status(content: &str, content_changed: bool, now: f64, last_change: f64) -> AgentStatus {
    let elapsed = now - last_change;

    // Check bottom 5 lines for busy indicators
    let lines: Vec<&str> = content.lines().collect();
    let bottom = if lines.len() > 5 { &lines[lines.len() - 5..] } else { &lines };
    let bottom_text: String = bottom.join("\n");

    let has_busy = BUSY_INDICATORS.iter().any(|ind| bottom_text.contains(ind));
    let has_prompt = bottom_text.contains(PROMPT_INDICATOR);

    if has_busy {
        return AgentStatus::Busy;
    }

    if content_changed && elapsed < 15_000.0 {
        // Content recently changed, cooling down
        return AgentStatus::Busy;
    }

    if has_prompt && elapsed >= 2_000.0 {
        return AgentStatus::Ready;
    }

    if elapsed >= 40_000.0 {
        if has_prompt {
            AgentStatus::Ready
        } else {
            AgentStatus::Idle
        }
    } else {
        AgentStatus::Busy
    }
}

/// Extract preview: last non-empty line, max 120 chars, strip ANSI
fn extract_preview(content: &str) -> String {
    content
        .lines()
        .rev()
        .map(strip_ansi)
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .chars()
        .take(120)
        .collect()
}

/// Simple string hash (djb2)
fn simple_hash(s: &str) -> u64 {
    let mut hash: u64 = 5381;
    for byte in s.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(byte as u64);
    }
    hash
}

/// Strip ANSI escape codes
fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip escape sequence
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                // consume until letter
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            result.push(c);
        }
    }
    result
}
