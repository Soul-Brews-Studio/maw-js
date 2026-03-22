use bevy::prelude::*;
use bevy::input::mouse::{MouseButton, MouseWheel};
use crate::player::RoomZoom;

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, setup_camera)
            .add_systems(Update, (camera_zoom, camera_pan));
    }
}

#[derive(Component)]
pub struct MainCamera;

fn setup_camera(mut commands: Commands) {
    commands.spawn((
        Camera2d::default(),
        MainCamera,
        OrthographicProjection {
            scale: 1.8, // start zoomed out (outdoor)
            ..OrthographicProjection::default_2d()
        },
        Transform::from_xyz(0.0, 0.0, 999.0),
    ));
}

/// Ctrl + scroll to manually adjust zoom (overrides auto-zoom temporarily)
fn camera_zoom(
    mut scroll_events: EventReader<MouseWheel>,
    keys: Res<ButtonInput<KeyCode>>,
    mut room_zoom: ResMut<RoomZoom>,
) {
    if !keys.pressed(KeyCode::ControlLeft) && !keys.pressed(KeyCode::ControlRight) {
        scroll_events.clear();
        return;
    }

    for event in scroll_events.read() {
        let zoom_delta = -event.y * 0.15;
        room_zoom.target_scale = (room_zoom.target_scale + zoom_delta).clamp(0.3, 5.0);
    }
}

/// Space + drag to pan camera
fn camera_pan(
    keys: Res<ButtonInput<KeyCode>>,
    mouse_button: Res<ButtonInput<MouseButton>>,
    mut motion_events: EventReader<bevy::input::mouse::MouseMotion>,
    mut query: Query<(&mut Transform, &OrthographicProjection), With<MainCamera>>,
) {
    if keys.pressed(KeyCode::Space) && mouse_button.pressed(MouseButton::Left) {
        let Ok((mut transform, projection)) = query.get_single_mut() else { return };
        for event in motion_events.read() {
            transform.translation.x -= event.delta.x * projection.scale;
            transform.translation.y += event.delta.y * projection.scale;
        }
    } else {
        motion_events.clear();
    }
}
