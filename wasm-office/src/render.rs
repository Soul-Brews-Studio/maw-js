//! Room-mode renderer — agents inside rectangular room zones like a game map.

use macroquad::prelude::*;
use crate::types::*;
use crate::colors::*;

const TEXT_DIM: Color = Color::new(1.0, 1.0, 1.0, 0.35);
const WALL_COLOR: Color = Color::new(1.0, 1.0, 1.0, 0.06);
const WALL_BORDER: Color = Color::new(1.0, 1.0, 1.0, 0.12);
const GRID_COLOR: Color = Color::new(1.0, 1.0, 1.0, 0.02);

/// Room layout position (world coordinates)
struct RoomLayout {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

/// Calculate room positions in a grid layout
fn layout_rooms(rooms: &[RoomData]) -> Vec<RoomLayout> {
    let n = rooms.len();
    if n == 0 { return vec![]; }

    // Grid: try to be roughly square
    let cols = (n as f32).sqrt().ceil() as usize;
    let rows = (n + cols - 1) / cols;

    let room_w = 400.0;
    let room_h = 320.0;
    let gap = 60.0;
    let total_w = cols as f32 * (room_w + gap) - gap;
    let total_h = rows as f32 * (room_h + gap) - gap;
    let start_x = -total_w / 2.0;
    let start_y = -total_h / 2.0;

    rooms.iter().enumerate().map(|(i, room)| {
        let col = i % cols;
        let row = i / cols;
        // Scale room by agent count
        let agent_count = room.agent_targets.len().max(1);
        let scale = 1.0 + (agent_count as f32 - 1.0).max(0.0) * 0.06;
        RoomLayout {
            x: start_x + col as f32 * (room_w + gap),
            y: start_y + row as f32 * (room_h + gap),
            w: room_w * scale,
            h: room_h * scale,
        }
    }).collect()
}

/// Draw the background grid
pub fn draw_grid(sw: f32, sh: f32, cam_x: f32, cam_y: f32, zoom: f32) {
    let grid_size = 80.0 * zoom;
    let offset_x = (-cam_x * zoom + sw / 2.0) % grid_size;
    let offset_y = (-cam_y * zoom + sh / 2.0) % grid_size;

    let mut x = offset_x;
    while x < sw {
        draw_line(x, 0.0, x, sh, 1.0, GRID_COLOR);
        x += grid_size;
    }
    let mut y = offset_y;
    while y < sh {
        draw_line(0.0, y, sw, y, 1.0, GRID_COLOR);
        y += grid_size;
    }
}

/// Draw all rooms and agents, returns hovered agent target
pub fn draw_rooms(
    store: &DataStore,
    cam_x: f32, cam_y: f32, zoom: f32,
    sw: f32, sh: f32,
    mouse: (f32, f32),
    time: f32,
) -> Option<String> {
    let to_screen = |wx: f32, wy: f32| -> (f32, f32) {
        ((wx - cam_x) * zoom + sw / 2.0, (wy - cam_y) * zoom + sh / 2.0)
    };

    let layouts = layout_rooms(&store.rooms);
    let mut hovered: Option<String> = None;

    for (ri, room) in store.rooms.iter().enumerate() {
        let layout = &layouts[ri];
        let (sx, sy) = to_screen(layout.x, layout.y);
        let rw = layout.w * zoom;
        let rh = layout.h * zoom;

        let rc = room_color(&room.name);

        // Room background
        draw_rectangle(sx, sy, rw, rh, WALL_COLOR);

        // Room border (colored by room)
        draw_rectangle_lines(sx, sy, rw, rh, 2.0, Color::new(rc.r, rc.g, rc.b, 0.3));

        // Room corner accents
        let corner_len = 16.0 * zoom;
        let corner_c = Color::new(rc.r, rc.g, rc.b, 0.5);
        // Top-left
        draw_line(sx, sy, sx + corner_len, sy, 2.0, corner_c);
        draw_line(sx, sy, sx, sy + corner_len, 2.0, corner_c);
        // Top-right
        draw_line(sx + rw, sy, sx + rw - corner_len, sy, 2.0, corner_c);
        draw_line(sx + rw, sy, sx + rw, sy + corner_len, 2.0, corner_c);
        // Bottom-left
        draw_line(sx, sy + rh, sx + corner_len, sy + rh, 2.0, corner_c);
        draw_line(sx, sy + rh, sx, sy + rh - corner_len, 2.0, corner_c);
        // Bottom-right
        draw_line(sx + rw, sy + rh, sx + rw - corner_len, sy + rh, 2.0, corner_c);
        draw_line(sx + rw, sy + rh, sx + rw, sy + rh - corner_len, 2.0, corner_c);

        // Room name (top-left inside)
        let label = room.name.to_uppercase();
        let font_size = (18.0 * zoom) as u16;
        draw_text(&label, sx + 12.0 * zoom, sy + 24.0 * zoom, font_size as f32, rc);

        // Agent count badge (top-right)
        let n = room.agent_targets.len();
        let badge = format!("{}", n);
        let badge_w = measure_text(&badge, None, (14.0 * zoom) as u16, 1.0).width;
        let badge_x = sx + rw - badge_w - 16.0 * zoom;
        let badge_y = sy + 22.0 * zoom;
        draw_circle(badge_x + badge_w / 2.0, badge_y - 4.0 * zoom, 12.0 * zoom,
            Color::new(rc.r, rc.g, rc.b, 0.15));
        draw_text(&badge, badge_x, badge_y, 14.0 * zoom, rc);

        // Status summary line
        let (mut busy, mut ready, mut idle) = (0, 0, 0);
        for t in &room.agent_targets {
            if let Some(a) = store.agents.get(t) {
                match a.status {
                    AgentStatus::Busy => busy += 1,
                    AgentStatus::Ready => ready += 1,
                    AgentStatus::Idle => idle += 1,
                }
            }
        }
        let summary = format!("{}B  {}R  {}I", busy, ready, idle);
        let sum_w = measure_text(&summary, None, (10.0 * zoom) as u16, 1.0).width;
        draw_text(&summary, sx + rw - sum_w - 12.0 * zoom, sy + rh - 10.0 * zoom,
            10.0 * zoom, TEXT_DIM);

        // Agents inside room — grid layout
        let avatar_size = 56.0 * zoom;
        let padding = 16.0 * zoom;
        let agent_area_y = sy + 44.0 * zoom; // below title
        let agent_area_h = rh - 60.0 * zoom;
        let cols_per_row = ((rw - padding * 2.0) / (avatar_size + padding)) as usize;
        let cols_per_row = cols_per_row.max(1);

        for (ai, target) in room.agent_targets.iter().enumerate() {
            let agent = match store.agents.get(target) {
                Some(a) => a,
                None => continue,
            };

            let col = ai % cols_per_row;
            let row = ai / cols_per_row;
            let ax = sx + padding + col as f32 * (avatar_size + padding) + avatar_size / 2.0;
            let ay = agent_area_y + padding + row as f32 * (avatar_size + padding + 14.0 * zoom) + avatar_size / 2.0;

            // Skip if outside room
            if ay > sy + rh - 20.0 * zoom { continue; }

            let is_saiyan = store.saiyan_targets.contains(&agent.target);
            draw_agent_node(ax, ay, agent, avatar_size, zoom, time, ai, is_saiyan);

            // Hover hit test
            let dx = mouse.0 - ax;
            let dy = mouse.1 - ay;
            if dx * dx + dy * dy < (avatar_size * 0.5).powi(2) {
                hovered = Some(agent.target.clone());
                draw_circle_lines(ax, ay, avatar_size * 0.45, 2.0 * zoom, agent_accent(&agent.name));
            }
        }

        // Connection lines between rooms (subtle)
        if ri + 1 < store.rooms.len() {
            let next = &layouts[(ri + 1) % layouts.len()];
            let (nx, ny) = to_screen(next.x, next.y);
            let from_x = sx + rw;
            let from_y = sy + rh / 2.0;
            let to_x = nx;
            let to_y = ny + next.h * zoom / 2.0;
            draw_line(from_x, from_y, to_x, to_y, 1.0, Color::new(1.0, 1.0, 1.0, 0.03));
        }
    }

    hovered
}

/// Draw a single agent node (circle + status + name)
fn draw_agent_node(ax: f32, ay: f32, agent: &AgentData, size: f32, zoom: f32, time: f32, idx: usize, saiyan: bool) {
    let color = agent_accent(&agent.name);
    let is_busy = agent.status == AgentStatus::Busy;

    // Saiyan glow
    if saiyan {
        let a = 0.15 + (time * 4.0 + idx as f32).sin().abs() * 0.15;
        draw_circle(ax, ay, size * 0.55, Color::new(1.0, 0.85, 0.0, a));
    }

    // Busy pulse
    if is_busy {
        let a = 0.04 + (time * 2.0 + idx as f32).sin().abs() * 0.04;
        draw_circle(ax, ay, size * 0.48, Color::new(color.r, color.g, color.b, a));
    }

    // Avatar circle
    let r = size * 0.32;
    draw_circle(ax, ay, r, Color::new(color.r, color.g, color.b, 0.9));
    draw_circle_lines(ax, ay, r + 1.0, 1.5, Color::new(1.0, 1.0, 1.0, 0.2));

    // Initial
    let initial = agent.name.chars().next().unwrap_or('?').to_uppercase().to_string();
    let fs = (18.0 * zoom) as u16;
    let iw = measure_text(&initial, None, fs, 1.0);
    draw_text(&initial, ax - iw.width / 2.0, ay + iw.height / 4.0, fs as f32, WHITE);

    // Status dot (top-right of avatar)
    let dot_r = 5.0 * zoom;
    let dot_x = ax + r * 0.7;
    let dot_y = ay - r * 0.7;
    draw_circle(dot_x, dot_y, dot_r + 1.5, Color::new(0.04, 0.04, 0.06, 1.0)); // outline
    draw_circle(dot_x, dot_y, dot_r, status_color(&agent.status));

    // Name below
    let name_fs = (11.0 * zoom) as u16;
    let nw = measure_text(&agent.name, None, name_fs, 1.0).width;
    draw_text(&agent.name, ax - nw / 2.0, ay + r + 14.0 * zoom, name_fs as f32,
        if is_busy { color } else { Color::new(1.0, 1.0, 1.0, 0.6) });
}

/// Draw header bar
pub fn draw_header(sw: f32, time: f32, stats: &OfficeStats, room_count: usize, zoom: f32) {
    let h = 56.0;
    draw_rectangle(0.0, 0.0, sw, h, Color::new(0.04, 0.04, 0.06, 0.95));
    draw_line(0.0, h, sw, h, 1.0, WALL_BORDER);

    draw_text("M I S S I O N   C O N T R O L", 24.0, 38.0, 22.0, hex_color("#64b5f6"));

    // Live dot
    let la = 0.5 + (time * 2.0).sin().abs() * 0.5;
    draw_circle(sw - 350.0, 30.0, 5.0, Color::new(0.2, 0.9, 0.4, la));
    draw_text("LIVE", sw - 338.0, 36.0, 14.0, Color::new(0.2, 0.9, 0.4, 1.0));

    // Stats
    let st = format!("{} agents  ·  {} rooms  ·  {} busy  ·  {} ready",
        stats.total, room_count, stats.busy, stats.ready);
    let stw = measure_text(&st, None, 13, 1.0).width;
    draw_text(&st, sw - stw - 20.0, 36.0, 13.0, TEXT_DIM);
}

/// Draw footer bar
pub fn draw_footer(sw: f32, sh: f32, stats: &OfficeStats, saiyan: &[String], zoom: f32) {
    let h = 36.0;
    let y = sh - h;
    draw_rectangle(0.0, y, sw, h, Color::new(0.04, 0.04, 0.06, 0.95));
    draw_line(0.0, y, sw, y, 1.0, WALL_BORDER);

    let mid = y + h / 2.0 + 4.0;

    // Status dots
    let mut x = 24.0;
    draw_circle(x, mid - 4.0, 4.0, hex_color("#fdd835"));
    x += 10.0;
    draw_text(&format!("{} busy", stats.busy), x, mid, 12.0, TEXT_DIM);
    x += 80.0;
    draw_circle(x, mid - 4.0, 4.0, hex_color("#4caf50"));
    x += 10.0;
    draw_text(&format!("{} ready", stats.ready), x, mid, 12.0, TEXT_DIM);
    x += 80.0;
    draw_circle(x, mid - 4.0, 4.0, Color::new(1.0, 1.0, 1.0, 0.3));
    x += 10.0;
    draw_text(&format!("{} idle", stats.idle), x, mid, 12.0, TEXT_DIM);

    if !saiyan.is_empty() {
        x += 80.0;
        draw_circle(x, mid - 4.0, 4.0, hex_color("#ff5722"));
        x += 10.0;
        draw_text(&format!("{} saiyan", saiyan.len()), x, mid, 12.0, hex_color("#ff5722"));
    }

    // Zoom + FPS (right side)
    let zt = format!("{}%", (zoom * 100.0) as u32);
    let zw = measure_text(&zt, None, 12, 1.0).width;
    draw_text(&zt, sw - zw - 20.0, mid, 12.0, TEXT_DIM);

    let fps = format!("{}fps", get_fps());
    let fw = measure_text(&fps, None, 12, 1.0).width;
    draw_text(&fps, sw - zw - fw - 40.0, mid, 12.0, TEXT_DIM);

    // Resolution
    let res = format!("{:.0}×{:.0}", sw, sh);
    let rw = measure_text(&res, None, 10, 1.0).width;
    draw_text(&res, sw - zw - fw - rw - 60.0, mid, 10.0, Color::new(1.0, 1.0, 1.0, 0.2));
}
