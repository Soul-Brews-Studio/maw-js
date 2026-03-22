use bevy::prelude::*;
use bevy::asset::AssetMetaCheck;

mod tilemap;
mod agents;
mod camera;
mod bridge;
mod colors;
mod player;

use tilemap::TilemapPlugin;
use agents::AgentsPlugin;
use camera::CameraPlugin;
use bridge::BridgePlugin;
use player::PlayerPlugin;

fn main() {
    App::new()
        .add_plugins(
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: Some(Window {
                        title: "Oracle Office 8-bit".to_string(),
                        resolution: (1024., 768.).into(),
                        canvas: Some("#office-canvas".to_string()),
                        fit_canvas_to_parent: true,
                        prevent_default_event_handling: true,
                        ..default()
                    }),
                    ..default()
                })
                .set(ImagePlugin::default_nearest())
                .set(AssetPlugin {
                    file_path: "office-8bit/assets".to_string(),
                    meta_check: AssetMetaCheck::Never,
                    ..default()
                }),
        )
        .insert_resource(ClearColor(Color::srgb(
            0.04, 0.04, 0.06, // #0a0a0f
        )))
        .add_plugins((
            TilemapPlugin,
            AgentsPlugin,
            CameraPlugin,
            BridgePlugin,
            PlayerPlugin,
        ))
        .run();
}
