mod types;
mod colors;
mod exports;
mod store;
mod render;

use macroquad::prelude::*;
use types::DataStore;
use colors::agent_accent_hex;
use store::*;
use render::{draw_grid as draw_bg_grid, draw_rooms, draw_header, draw_footer};

const BG: Color = Color::new(0.04, 0.04, 0.06, 1.0);

fn window_conf() -> Conf {
    Conf {
        window_title: "Oracle Office".to_string(),
        window_width: 2048,
        window_height: 1536,
        high_dpi: true,
        ..Default::default()
    }
}

#[macroquad::main(window_conf)]
async fn main() {
    {
        let mut s = DATA.lock().unwrap();
        *s = Some(DataStore::new());
    }

    let mut time = 0.0f32;
    let mut cam_x = 0.0f32;
    let mut cam_y = 0.0f32;
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
        if wheel_y != 0.0 { zoom = (zoom + wheel_y * 0.05).clamp(0.2, 4.0); }
        if is_mouse_button_down(MouseButton::Left) && hovered_agent.is_none() {
            let d = mouse_delta_position();
            cam_x -= d.x * sw / zoom * 0.5;
            cam_y -= d.y * sh / zoom * 0.5;
        }

        clear_background(BG);

        // Background grid
        draw_bg_grid(sw, sh, cam_x, cam_y, zoom);

        // Lock data
        let guard = DATA.lock().unwrap();
        let store = match guard.as_ref() {
            Some(s) => s,
            None => { drop(guard); next_frame().await; continue; }
        };

        // Draw rooms + agents
        hovered_agent = draw_rooms(store, cam_x, cam_y, zoom, sw, sh, mouse, time);

        // Update popup output for JS (WASM → JS bridge)
        if hovered_agent != prev_hovered {
            let mut out = OUTPUT.lock().unwrap();
            *out = match &hovered_agent {
                Some(target) => match store.agents.get(target) {
                    Some(a) => format!("1|{:.0}|{:.0}|{}|{}|{}|{}|{}|{}",
                        mouse.0, mouse.1 - 80.0,
                        a.name, a.session, a.status.as_str(),
                        a.preview, agent_accent_hex(&a.name), a.target),
                    None => "0".to_string(),
                },
                None => "0".to_string(),
            };
            prev_hovered = hovered_agent.clone();
        }

        // HUD
        draw_header(sw, time, &store.stats, store.rooms.len(), zoom);
        draw_footer(sw, sh, &store.stats, &store.saiyan_targets, zoom);

        // Empty state
        if store.agents.is_empty() {
            let msg = "Waiting for agent data from JS...";
            let mw = measure_text(msg, None, 20, 1.0).width;
            let a = 0.3 + (time * 1.5).sin().abs() * 0.3;
            draw_text(msg, sw / 2.0 - mw / 2.0, sh / 2.0, 20.0, Color::new(1.0, 1.0, 1.0, a));
        }

        drop(guard);
        next_frame().await;
    }
}
