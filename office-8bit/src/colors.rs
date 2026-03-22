use bevy::prelude::*;

// Oracle agent accent colors (Material Design)
pub fn agent_color(name: &str) -> Color {
    match name {
        "neo" => Color::srgb_u8(100, 181, 246),    // #64b5f6 — Blue 300
        "nexus" => Color::srgb_u8(129, 199, 132),  // #81c784 — Green 400
        "hermes" => Color::srgb_u8(255, 183, 77),  // #ffb74d — Orange 400
        "pulse" => Color::srgb_u8(240, 98, 146),   // #f06292 — Pink 300
        "mother" => Color::srgb_u8(206, 147, 216), // #ce93d8 — Purple 300
        "odin" => Color::srgb_u8(77, 182, 172),    // #4db6ac — Teal 300
        _ => Color::srgb_u8(144, 164, 174),        // #90a4ae — Blue Grey 300
    }
}

// Status colors
pub fn status_color(status: &str) -> Color {
    match status {
        "busy" => Color::srgb_u8(253, 216, 53),  // #fdd835 — Amber
        "ready" => Color::srgb_u8(76, 175, 80),  // #4caf50 — Green
        _ => Color::srgba(1.0, 1.0, 1.0, 0.3),  // Dim white
    }
}

// Room theme colors
pub fn room_color(name: &str) -> Color {
    match name.to_lowercase().as_str() {
        "oracles" => Color::srgb_u8(100, 181, 246),
        "brewing" => Color::srgb_u8(121, 85, 72),
        "tools" => Color::srgb_u8(78, 182, 172),
        "watchers" => Color::srgb_u8(255, 183, 77),
        _ => Color::srgb_u8(120, 144, 156),
    }
}

// Background tile colors
pub const BG_DARK: Color = Color::srgb(0.06, 0.06, 0.08);
pub const BG_FLOOR: Color = Color::srgb(0.10, 0.10, 0.14);
pub const WALL_COLOR: Color = Color::srgb(0.18, 0.18, 0.24);
pub const GRID_COLOR: Color = Color::srgba(1.0, 1.0, 1.0, 0.03);
