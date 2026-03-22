use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use crate::agents::{Agent, AgentData, AgentRegistry, AgentStatus, AgentSprite};
use crate::camera::MainCamera;
use crate::player::Player;
use crate::tilemap::SCALED_TILE;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub struct BridgePlugin;

impl Plugin for BridgePlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(PopupState::default())
            .add_systems(Update, (
                poll_js_data,
                detect_player_proximity,
                detect_hover,
                export_popup_state,
                send_bg_to_js,
            ));
    }
}

// --- Popup state ---

#[derive(Clone, Copy, PartialEq)]
enum PopupSource {
    None,
    Hover,
    Proximity,
}

#[derive(Resource)]
pub struct PopupState {
    pub output: String,
    pub changed: bool,
    source: PopupSource,
}

impl Default for PopupState {
    fn default() -> Self {
        PopupState {
            output: "0".to_string(),
            changed: false,
            source: PopupSource::None,
        }
    }
}

// JS functions
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = window, js_name = "__oracle_agents")]
    fn get_oracle_agents() -> Option<String>;

    #[wasm_bindgen(js_namespace = window, js_name = "__oracle_show_popup")]
    fn show_popup(target: &str, x: f32, y: f32);

    #[wasm_bindgen(js_namespace = window, js_name = "__oracle_hide_popup")]
    fn hide_popup();

    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);

    #[wasm_bindgen(js_namespace = window, js_name = "__oracle_set_bg")]
    fn set_bg(image_url: &str);
}

// --- Background ---

#[derive(Resource)]
struct BgSent(bool);

fn send_bg_to_js(
    mut commands: Commands,
    bg_sent: Option<Res<BgSent>>,
) {
    if bg_sent.is_some() { return; }
    commands.insert_resource(BgSent(true));

    #[cfg(target_arch = "wasm32")]
    {
        set_bg("office-8bit/assets/tiles/walls.png");
    }
}

// --- Hover detection (mouse) ---

fn detect_hover(
    window_q: Query<&Window, With<PrimaryWindow>>,
    camera_q: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    agents: Query<(&Agent, &GlobalTransform), Without<AgentSprite>>,
    mut popup: ResMut<PopupState>,
) {
    // Don't override proximity popup
    if popup.source == PopupSource::Proximity {
        return;
    }

    let Ok(window) = window_q.get_single() else { return };
    let Ok((camera, camera_transform)) = camera_q.get_single() else { return };

    let Some(cursor_pos) = window.cursor_position() else {
        if popup.source == PopupSource::Hover {
            popup.output = "0".to_string();
            popup.changed = true;
            popup.source = PopupSource::None;
        }
        return;
    };

    let Ok(world_pos) = camera.viewport_to_world_2d(camera_transform, cursor_pos) else {
        return;
    };

    let hover_radius = SCALED_TILE * 1.0;

    for (agent, agent_transform) in agents.iter() {
        let agent_pos = agent_transform.translation().truncate();
        let dist = (world_pos - agent_pos).length();

        if dist < hover_radius {
            let status_str = status_to_str(&agent.status);
            let new_output = format!(
                "1|{}|{}|{}|{}|{}",
                cursor_pos.x, cursor_pos.y,
                agent.name, agent.target, status_str
            );

            if popup.output != new_output {
                popup.output = new_output;
                popup.changed = true;
                popup.source = PopupSource::Hover;
            }
            return;
        }
    }

    if popup.source == PopupSource::Hover {
        popup.output = "0".to_string();
        popup.changed = true;
        popup.source = PopupSource::None;
    }
}

// --- Player proximity detection (WASD collision) ---

fn detect_player_proximity(
    player_q: Query<&GlobalTransform, With<Player>>,
    window_q: Query<&Window, With<PrimaryWindow>>,
    agents: Query<(&Agent, &GlobalTransform), Without<AgentSprite>>,
    mut popup: ResMut<PopupState>,
) {
    let Ok(player_transform) = player_q.get_single() else { return };
    let Ok(window) = window_q.get_single() else { return };

    let player_pos = player_transform.translation().truncate();
    let proximity = SCALED_TILE * 1.5;

    let center_x = window.width() / 2.0;
    let center_y = window.height() / 2.0;

    for (agent, agent_transform) in agents.iter() {
        let agent_pos = agent_transform.translation().truncate();
        let dist = (player_pos - agent_pos).length();

        if dist < proximity {
            let status_str = status_to_str(&agent.status);
            let new_output = format!(
                "1|{}|{}|{}|{}|{}",
                center_x, center_y,
                agent.name, agent.target, status_str
            );

            if popup.output != new_output {
                popup.output = new_output;
                popup.changed = true;
                popup.source = PopupSource::Proximity;
            }
            return;
        }
    }

    // Player moved away — clear proximity popup
    if popup.source == PopupSource::Proximity {
        popup.output = "0".to_string();
        popup.changed = true;
        popup.source = PopupSource::None;
    }
}

fn status_to_str(status: &AgentStatus) -> &'static str {
    match status {
        AgentStatus::Busy => "busy",
        AgentStatus::Ready => "ready",
        AgentStatus::Saiyan => "saiyan",
        AgentStatus::Idle => "idle",
    }
}

// --- Export popup to JS ---

fn export_popup_state(
    mut popup: ResMut<PopupState>,
) {
    if !popup.changed { return; }
    popup.changed = false;

    #[cfg(target_arch = "wasm32")]
    {
        if popup.output.starts_with('1') {
            let parts: Vec<&str> = popup.output.split('|').collect();
            if parts.len() >= 5 {
                let x: f32 = parts[1].parse().unwrap_or(0.0);
                let y: f32 = parts[2].parse().unwrap_or(0.0);
                show_popup(parts[4], x, y);
            }
        } else {
            hide_popup();
        }
    }
}

// --- Data polling ---

#[derive(Resource)]
struct PollTimer(Timer);

impl Default for PollTimer {
    fn default() -> Self {
        PollTimer(Timer::from_seconds(2.0, TimerMode::Repeating))
    }
}

fn poll_js_data(
    mut registry: ResMut<AgentRegistry>,
    time: Res<Time>,
    poll_timer: Option<ResMut<PollTimer>>,
    mut commands: Commands,
) {
    let mut timer = match poll_timer {
        Some(t) => t,
        None => {
            commands.insert_resource(PollTimer::default());
            return;
        }
    };

    timer.0.tick(time.delta());
    if !timer.0.just_finished() { return; }

    #[cfg(target_arch = "wasm32")]
    {
        if let Some(json) = get_oracle_agents() {
            if let Ok(agents) = parse_agents(&json) {
                registry.agents = agents;
                registry.dirty = true;
            }
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        if registry.agents.is_empty() {
            registry.agents = vec![
                AgentData { target: "oracle:0".into(), name: "neo".into(), session: "oracles".into(), status: AgentStatus::Busy, preview: "Building...".into() },
                AgentData { target: "oracle:1".into(), name: "nexus".into(), session: "oracles".into(), status: AgentStatus::Ready, preview: "Waiting".into() },
                AgentData { target: "oracle:2".into(), name: "hermes".into(), session: "brewing".into(), status: AgentStatus::Busy, preview: "Routing...".into() },
                AgentData { target: "oracle:3".into(), name: "pulse".into(), session: "tools".into(), status: AgentStatus::Saiyan, preview: "Sprint!".into() },
                AgentData { target: "oracle:4".into(), name: "odin".into(), session: "watchers".into(), status: AgentStatus::Idle, preview: "Observing".into() },
                AgentData { target: "oracle:5".into(), name: "mother".into(), session: "oracles".into(), status: AgentStatus::Ready, preview: "Principles".into() },
            ];
            registry.dirty = true;
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn parse_agents(json: &str) -> Result<Vec<AgentData>, ()> {
    let mut agents = Vec::new();
    for line in json.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 5 {
            agents.push(AgentData {
                target: parts[0].to_string(),
                name: parts[1].to_string(),
                session: parts[2].to_string(),
                status: AgentStatus::from_str(parts[3]),
                preview: parts[4].to_string(),
            });
        }
    }
    Ok(agents)
}
