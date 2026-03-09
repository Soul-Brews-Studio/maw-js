mod types;
mod colors;
mod exports;
mod store;

use macroquad::prelude::*;
use types::*;
use colors::*;
use store::*;

const BG: Color = Color::new(0.04, 0.04, 0.06, 1.0);
const TEXT_DIM: Color = Color::new(1.0, 1.0, 1.0, 0.35);

#[macroquad::main("Oracle Office")]
async fn main() {
    {
        let mut s = DATA.lock().unwrap();
        *s = Some(DataStore::new());
    }

    let mut time = 0.0f32;
    let mut cam_x = 480.0f32;
    let mut cam_y = 450.0f32;
    let mut zoom = 1.0f32;
    let mut hovered_agent: Option<String> = None;
    let mut prev_hovered: Option<String> = None;

    loop {
        time += get_frame_time();
        let sw = screen_width();
        let sh = screen_height();
        let mouse = mouse_position();

        // Input: zoom + pan
        let (_, wheel_y) = mouse_wheel();
        if wheel_y != 0.0 { zoom = (zoom + wheel_y * 0.05).clamp(0.3, 3.0); }
        if is_mouse_button_down(MouseButton::Left) && hovered_agent.is_none() {
            let d = mouse_delta_position();
            cam_x -= d.x * sw / zoom * 0.5;
            cam_y -= d.y * sh / zoom * 0.5;
        }

        clear_background(BG);

        let to_screen = |wx: f32, wy: f32| -> (f32, f32) {
            ((wx - cam_x) * zoom + sw * 0.5, (wy - cam_y) * zoom + sh * 0.5)
        };

        // Lock data
        let guard = DATA.lock().unwrap();
        let store = match guard.as_ref() {
            Some(s) => s,
            None => { drop(guard); next_frame().await; continue; }
        };

        // Draw background
        draw_orbital_rings(to_screen, zoom);

        // Draw center
        let (cx, cy) = to_screen(480.0, 450.0);
        draw_center(cx, cy, zoom);

        // Draw rooms + agents
        hovered_agent = None;
        let room_count = store.rooms.len().max(1);

        for (ri, room) in store.rooms.iter().enumerate() {
            let angle = (ri as f32 / room_count as f32) * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
            let (rx, ry) = to_screen(480.0 + angle.cos() * 250.0, 450.0 + angle.sin() * 250.0);

            draw_room(rx, ry, room, zoom);

            // Agents inside room
            let n = room.agent_targets.len();
            let cluster_r = (50.0 + n as f32 * 12.0) * zoom;
            let agent_r = if n == 1 { 0.0 } else {
                (cluster_r - 35.0 * zoom).min(35.0 * zoom + n as f32 * 6.0 * zoom)
            };
            let avatar_size = 48.0 * zoom;

            for (ai, target) in room.agent_targets.iter().enumerate() {
                let agent = match store.agents.get(target) {
                    Some(a) => a,
                    None => continue,
                };
                let aa = (ai as f32 / n.max(1) as f32) * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                let ax = rx + aa.cos() * agent_r;
                let ay = ry + aa.sin() * agent_r;

                draw_agent(ax, ay, agent, avatar_size, zoom, time, ai,
                    store.saiyan_targets.contains(&agent.target));

                // Hover hit test
                let dx = mouse.0 - ax;
                let dy = mouse.1 - ay;
                if dx * dx + dy * dy < (avatar_size * 0.5).powi(2) {
                    hovered_agent = Some(agent.target.clone());
                    draw_circle_lines(ax, ay, avatar_size * 0.45, 2.0 * zoom, agent_accent(&agent.name));
                }
            }
        }

        // Update popup output for JS
        if hovered_agent != prev_hovered {
            let mut out = OUTPUT.lock().unwrap();
            *out = match &hovered_agent {
                Some(target) => match store.agents.get(target) {
                    Some(a) => format!("1|{:.0}|{:.0}|{}|{}|{}|{}|{}",
                        mouse.0, mouse.1 - 80.0,
                        a.name, a.session, a.status.as_str(),
                        a.preview, agent_accent_hex(&a.name)),
                    None => "0".to_string(),
                },
                None => "0".to_string(),
            };
            prev_hovered = hovered_agent.clone();
        }

        // HUD
        draw_header(sw, time, &store.stats, store.rooms.len());
        draw_footer(sw, sh, &store.stats, &store.saiyan_targets, zoom);

        // Empty state
        if store.agents.is_empty() {
            let msg = "Waiting for agent data from JS...";
            let mw = measure_text(msg, None, 18, 1.0).width;
            let a = 0.3 + (time * 1.5).sin().abs() * 0.3;
            draw_text(msg, sw / 2.0 - mw / 2.0, sh / 2.0, 18.0, Color::new(1.0, 1.0, 1.0, a));
        }

        drop(guard);
        next_frame().await;
    }
}

// ============================================================
// Drawing helpers
// ============================================================

fn draw_orbital_rings(to_screen: impl Fn(f32, f32) -> (f32, f32), zoom: f32) {
    let (cx, cy) = to_screen(480.0, 450.0);
    for (r, a) in [(150.0, 0.08), (300.0, 0.06), (450.0, 0.04)] {
        draw_circle_lines(cx, cy, r * zoom, 0.5, Color::new(0.5, 0.5, 0.7, a));
    }
}

fn draw_center(cx: f32, cy: f32, zoom: f32) {
    draw_circle(cx, cy, 7.0 * zoom, hex_color("#26c6da"));
    draw_circle_lines(cx, cy, 45.0 * zoom, 1.0, Color::new(0.15, 0.78, 0.85, 0.15));
    let t = "MISSION CONTROL";
    let w = measure_text(t, None, (12.0 * zoom) as u16, 1.0).width;
    draw_text(t, cx - w / 2.0, cy + 55.0 * zoom, 12.0 * zoom, TEXT_DIM);
}

fn draw_room(rx: f32, ry: f32, room: &RoomData, zoom: f32) {
    let n = room.agent_targets.len();
    let cluster_r = (50.0 + n as f32 * 12.0) * zoom;
    let rc = room_color(&room.name);

    draw_circle(rx, ry, cluster_r, Color::new(rc.r, rc.g, rc.b, 0.04));
    draw_circle_lines(rx, ry, cluster_r, 1.0, Color::new(rc.r, rc.g, rc.b, 0.15));

    let label = room.name.to_uppercase();
    let lw = measure_text(&label, None, (14.0 * zoom) as u16, 1.0).width;
    draw_text(&label, rx - lw / 2.0, ry - cluster_r - 10.0 * zoom, 14.0 * zoom, rc);

    let ct = format!("{} agent{}", n, if n != 1 { "s" } else { "" });
    let cw = measure_text(&ct, None, (10.0 * zoom) as u16, 1.0).width;
    draw_text(&ct, rx - cw / 2.0, ry + cluster_r + 16.0 * zoom, 10.0 * zoom,
        Color::new(rc.r, rc.g, rc.b, 0.6));
}

fn draw_agent(ax: f32, ay: f32, agent: &AgentData, size: f32, zoom: f32, time: f32, idx: usize, saiyan: bool) {
    let color = agent_accent(&agent.name);
    let is_busy = agent.status == AgentStatus::Busy;

    // Saiyan glow
    if saiyan {
        let a = 0.15 + (time * 4.0 + idx as f32).sin().abs() * 0.15;
        draw_circle(ax, ay, size * 0.9, Color::new(1.0, 0.85, 0.0, a));
    }

    // Busy glow
    if is_busy {
        let a = 0.06 + (time * 2.0 + idx as f32).sin().abs() * 0.04;
        draw_circle(ax, ay, size * 0.7, Color::new(color.r, color.g, color.b, a));
    }

    // Circle with initial
    draw_circle(ax, ay, size * 0.35, color);
    draw_circle_lines(ax, ay, size * 0.35 + 1.0, 1.5, Color::new(1.0, 1.0, 1.0, 0.3));
    let initial = agent.name.chars().next().unwrap_or('?').to_uppercase().to_string();
    let iw = measure_text(&initial, None, (16.0 * zoom) as u16, 1.0);
    draw_text(&initial, ax - iw.width / 2.0, ay + iw.height / 4.0, 16.0 * zoom, WHITE);

    // Status dot
    draw_circle(ax + size * 0.3, ay - size * 0.3, 4.0 * zoom, status_color(&agent.status));

    // Name
    let nw = measure_text(&agent.name, None, (10.0 * zoom) as u16, 1.0).width;
    draw_text(&agent.name, ax - nw / 2.0, ay + size * 0.45, 10.0 * zoom,
        if is_busy { color } else { Color::new(1.0, 1.0, 1.0, 0.7) });
}

fn draw_header(sw: f32, time: f32, stats: &OfficeStats, room_count: usize) {
    draw_rectangle(0.0, 0.0, sw, 48.0, Color::new(0.06, 0.06, 0.09, 0.95));
    draw_text("M I S S I O N   C O N T R O L", 24.0, 32.0, 20.0, hex_color("#64b5f6"));

    let la = 0.5 + (time * 2.0).sin().abs() * 0.5;
    draw_circle(sw - 300.0, 26.0, 4.0, Color::new(0.2, 0.9, 0.4, la));
    draw_text("LIVE", sw - 290.0, 32.0, 13.0, Color::new(0.2, 0.9, 0.4, 1.0));

    let st = format!("{}  agents    {}  rooms", stats.total, room_count);
    draw_text(&st, sw - 220.0, 32.0, 13.0, TEXT_DIM);
}

fn draw_footer(sw: f32, sh: f32, stats: &OfficeStats, saiyan: &[String], zoom: f32) {
    draw_rectangle(0.0, sh - 32.0, sw, 32.0, Color::new(0.06, 0.06, 0.09, 0.9));

    draw_circle(120.0, sh - 16.0, 4.0, hex_color("#fdd835"));
    draw_text(&format!("{} busy", stats.busy), 130.0, sh - 10.0, 12.0, TEXT_DIM);
    draw_circle(210.0, sh - 16.0, 4.0, hex_color("#4caf50"));
    draw_text(&format!("{} ready", stats.ready), 220.0, sh - 10.0, 12.0, TEXT_DIM);
    draw_circle(290.0, sh - 16.0, 4.0, Color::new(1.0, 1.0, 1.0, 0.3));
    draw_text(&format!("{} idle", stats.idle), 300.0, sh - 10.0, 12.0, TEXT_DIM);

    if !saiyan.is_empty() {
        draw_circle(380.0, sh - 16.0, 4.0, hex_color("#ff5722"));
        draw_text(&format!("{} saiyan", saiyan.len()), 390.0, sh - 10.0, 12.0, hex_color("#ff5722"));
    }

    let zt = format!("{}%", (zoom * 100.0) as u32);
    let zw = measure_text(&zt, None, 12, 1.0).width;
    draw_text(&zt, sw - zw - 16.0, sh - 10.0, 12.0, TEXT_DIM);
    draw_text(&format!("{}fps", get_fps()), 24.0, sh - 10.0, 12.0, TEXT_DIM);
}
