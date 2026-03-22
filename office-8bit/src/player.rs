use bevy::prelude::*;
use crate::agents::SpriteAssets;
use crate::camera::MainCamera;
use crate::tilemap::{OfficeMap, SCALED_TILE, WORLD_W, WORLD_H};

pub struct PlayerPlugin;

impl Plugin for PlayerPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(PlayerSpawned(false))
            .insert_resource(RoomZoom {
                target_scale: OUTDOOR_ZOOM,
                current_room: None,
            })
            .add_systems(Update, (
                spawn_player,
                player_movement,
                player_animation,
                detect_room_entry,
                camera_follow_player,
                camera_zoom_lerp,
            ));
    }
}

const OUTDOOR_ZOOM: f32 = 1.8;  // zoomed out when outside
const INDOOR_ZOOM: f32 = 0.8;   // zoomed in when inside a room

#[derive(Resource)]
struct PlayerSpawned(bool);

#[derive(Resource)]
pub struct RoomZoom {
    pub target_scale: f32,
    pub current_room: Option<usize>,
}

#[derive(Component)]
pub struct Player {
    pub speed: f32,
    pub facing: Facing,
    pub moving: bool,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Facing {
    Down,
    Up,
    Right,
    Left,
}

#[derive(Component)]
pub struct PlayerAnimation {
    pub timer: Timer,
    pub frame: usize,
}

fn spawn_player(
    mut commands: Commands,
    sprite_assets: Option<Res<SpriteAssets>>,
    office: Res<OfficeMap>,
    mut spawned: ResMut<PlayerSpawned>,
) {
    if spawned.0 { return; }
    let Some(sprite_assets) = sprite_assets else { return };
    if !office.spawned { return; }
    spawned.0 = true;

    let start_x = 15.0 * SCALED_TILE;
    let start_y = -(22.0 * SCALED_TILE);

    let mut sprite = Sprite::from_atlas_image(
        sprite_assets.characters[0].clone(),
        TextureAtlas {
            layout: sprite_assets.atlas_layout.clone(),
            index: 0,
        },
    );
    sprite.custom_size = Some(Vec2::new(SCALED_TILE, SCALED_TILE * 2.0));

    commands.spawn((
        Player {
            speed: 250.0,
            facing: Facing::Up,
            moving: false,
        },
        PlayerAnimation {
            timer: Timer::from_seconds(0.12, TimerMode::Repeating),
            frame: 0,
        },
        sprite,
        Transform::from_xyz(start_x, start_y, 10.0),
    ));
}

fn player_movement(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    office: Res<OfficeMap>,
    mut query: Query<(&mut Transform, &mut Player)>,
) {
    let Ok((mut transform, mut player)) = query.get_single_mut() else { return };

    if keys.pressed(KeyCode::Space) {
        player.moving = false;
        return;
    }

    let mut direction = Vec2::ZERO;

    if keys.pressed(KeyCode::KeyW) || keys.pressed(KeyCode::ArrowUp) {
        direction.y += 1.0;
        player.facing = Facing::Up;
    }
    if keys.pressed(KeyCode::KeyS) || keys.pressed(KeyCode::ArrowDown) {
        direction.y -= 1.0;
        player.facing = Facing::Down;
    }
    if keys.pressed(KeyCode::KeyA) || keys.pressed(KeyCode::ArrowLeft) {
        direction.x -= 1.0;
        player.facing = Facing::Left;
    }
    if keys.pressed(KeyCode::KeyD) || keys.pressed(KeyCode::ArrowRight) {
        direction.x += 1.0;
        player.facing = Facing::Right;
    }

    player.moving = direction.length() > 0.0;

    if player.moving {
        let delta = direction.normalize() * player.speed * time.delta_secs();
        let new_x = transform.translation.x + delta.x;
        let new_y = transform.translation.y + delta.y;

        if is_walkable(&office, new_x, new_y) {
            transform.translation.x = new_x;
            transform.translation.y = new_y;
        } else if is_walkable(&office, new_x, transform.translation.y) {
            transform.translation.x = new_x;
        } else if is_walkable(&office, transform.translation.x, new_y) {
            transform.translation.y = new_y;
        }
    }
}

fn is_walkable(office: &OfficeMap, world_x: f32, world_y: f32) -> bool {
    let tx = (world_x / SCALED_TILE).round() as i32;
    let ty = (-world_y / SCALED_TILE).round() as i32;

    if tx < 0 || ty < 0 || tx >= WORLD_W || ty >= WORLD_H {
        return false;
    }

    let tile = office.world[ty as usize][tx as usize];
    tile.is_walkable()
}

/// Detect if player is inside a room → zoom in, outside → zoom out
fn detect_room_entry(
    player_q: Query<&Transform, With<Player>>,
    office: Res<OfficeMap>,
    mut room_zoom: ResMut<RoomZoom>,
) {
    let Ok(player_pos) = player_q.get_single() else { return };

    let px = player_pos.translation.x;
    let py = player_pos.translation.y;

    // Check which room the player is in (if any)
    let mut in_room: Option<usize> = None;

    for (idx, room) in office.rooms.iter().enumerate() {
        let room_left = room.x as f32 * SCALED_TILE;
        let room_right = (room.x + room.width) as f32 * SCALED_TILE;
        let room_top = -(room.y as f32) * SCALED_TILE;
        let room_bottom = -((room.y + room.height) as f32) * SCALED_TILE;

        if px >= room_left && px <= room_right && py <= room_top && py >= room_bottom {
            in_room = Some(idx);
            break;
        }
    }

    if in_room != room_zoom.current_room {
        room_zoom.current_room = in_room;
        room_zoom.target_scale = if in_room.is_some() { INDOOR_ZOOM } else { OUTDOOR_ZOOM };
    }
}

fn player_animation(
    time: Res<Time>,
    mut query: Query<(&Player, &mut PlayerAnimation, &mut Sprite)>,
) {
    let Ok((player, mut anim, mut sprite)) = query.get_single_mut() else { return };

    let row = match player.facing {
        Facing::Down => 0,
        Facing::Up => 1,
        Facing::Right | Facing::Left => 2,
    };

    sprite.flip_x = player.facing == Facing::Left;

    if player.moving {
        let walk_frames = [0usize, 1, 2, 1];
        anim.timer.tick(time.delta());
        if anim.timer.just_finished() {
            anim.frame = (anim.frame + 1) % walk_frames.len();
        }
        let col = walk_frames[anim.frame];
        if let Some(atlas) = &mut sprite.texture_atlas {
            atlas.index = row * 7 + col;
        }
    } else {
        anim.frame = 0;
        if let Some(atlas) = &mut sprite.texture_atlas {
            atlas.index = row * 7;
        }
    }
}

/// Camera smoothly follows the player
fn camera_follow_player(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    player: Query<&Transform, (With<Player>, Without<MainCamera>)>,
    mut camera: Query<&mut Transform, With<MainCamera>>,
) {
    // Don't follow during Space+drag pan
    if keys.pressed(KeyCode::Space) { return; }

    let Ok(player_pos) = player.get_single() else { return };
    let Ok(mut cam_pos) = camera.get_single_mut() else { return };

    let target = player_pos.translation.truncate();
    let current = cam_pos.translation.truncate();
    let lerp_speed = 5.0 * time.delta_secs();
    let new_pos = current.lerp(target, lerp_speed.min(1.0));

    cam_pos.translation.x = new_pos.x;
    cam_pos.translation.y = new_pos.y;
}

/// Smoothly lerp camera zoom toward target scale
fn camera_zoom_lerp(
    time: Res<Time>,
    room_zoom: Res<RoomZoom>,
    mut camera: Query<&mut OrthographicProjection, With<MainCamera>>,
) {
    let Ok(mut projection) = camera.get_single_mut() else { return };

    let diff = room_zoom.target_scale - projection.scale;
    if diff.abs() < 0.01 {
        projection.scale = room_zoom.target_scale;
    } else {
        projection.scale += diff * 3.0 * time.delta_secs();
    }
}
