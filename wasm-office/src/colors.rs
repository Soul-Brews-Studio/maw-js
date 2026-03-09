//! Color palette — agent accents, room colors, status indicators.

use macroquad::prelude::Color;
use crate::types::AgentStatus;

pub fn hex_color(hex: &str) -> Color {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(128) as f32 / 255.0;
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(128) as f32 / 255.0;
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(128) as f32 / 255.0;
    Color::new(r, g, b, 1.0)
}

pub fn status_color(status: &AgentStatus) -> Color {
    match status {
        AgentStatus::Busy => hex_color("#fdd835"),
        AgentStatus::Ready => hex_color("#4caf50"),
        AgentStatus::Idle => Color::new(1.0, 1.0, 1.0, 0.3),
    }
}

pub fn agent_accent(name: &str) -> Color {
    hex_color(agent_accent_hex(name))
}

pub fn agent_accent_hex(name: &str) -> &'static str {
    match name {
        "neo" => "#64b5f6",
        "nexus" => "#81c784",
        "hermes" => "#ffb74d",
        "pulse" => "#4dd0e1",
        "homelab" => "#90caf9",
        "arthur" => "#ff8a65",
        "dustboy" => "#a1887f",
        "floodboy" => "#4dd0e1",
        "fireman" => "#ef5350",
        "mother" => "#ce93d8",
        "odin" => "#b39ddb",
        "volt" | "maeon" => "#fdd835",
        "xiaoer" => "#f48fb1",
        _ => "#90a4ae",
    }
}

pub fn room_color(name: &str) -> Color {
    match name.to_lowercase().as_str() {
        "oracles" => hex_color("#64b5f6"),
        "arra" => hex_color("#66bb6a"),
        "hermes" => hex_color("#ffb74d"),
        "brewing" => hex_color("#795548"),
        "watchers" => hex_color("#ce93d8"),
        "tools" => hex_color("#4dd0e1"),
        "solar" => hex_color("#fdd835"),
        _ => hex_color("#78909c"),
    }
}
