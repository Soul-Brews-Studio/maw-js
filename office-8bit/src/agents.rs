use bevy::prelude::*;
use crate::colors;
use crate::tilemap::{OfficeMap, SCALED_TILE};

pub struct AgentsPlugin;

impl Plugin for AgentsPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(AgentRegistry::default())
            .add_systems(Startup, load_sprite_assets)
            .add_systems(Update, (
                sync_agents,
                animate_sprite_frames,
                animate_status_indicators,
                agent_movement,
            ));
    }
}

// --- Sprite assets ---

#[derive(Resource)]
pub struct SpriteAssets {
    pub characters: Vec<Handle<Image>>,
    pub atlas_layout: Handle<TextureAtlasLayout>,
}

fn load_sprite_assets(
    mut commands: Commands,
    asset_server: Res<AssetServer>,
    mut atlas_layouts: ResMut<Assets<TextureAtlasLayout>>,
) {
    let characters: Vec<Handle<Image>> = (0..6)
        .map(|i| asset_server.load(format!("sprites/char_{i}.png")))
        .collect();

    // Character atlas: 7 columns × 3 rows, each frame 16×32
    let atlas_layout = atlas_layouts.add(
        TextureAtlasLayout::from_grid(UVec2::new(16, 32), 7, 3, None, None)
    );

    commands.insert_resource(SpriteAssets {
        characters,
        atlas_layout,
    });
}

// --- Data types ---

#[derive(Clone, Debug, PartialEq)]
pub enum AgentStatus {
    Busy,
    Ready,
    Idle,
    Saiyan,
}

impl AgentStatus {
    pub fn from_str(s: &str) -> Self {
        match s {
            "busy" => AgentStatus::Busy,
            "ready" => AgentStatus::Ready,
            "saiyan" => AgentStatus::Saiyan,
            _ => AgentStatus::Idle,
        }
    }
}

#[derive(Clone, Debug)]
pub struct AgentData {
    pub target: String,
    pub name: String,
    pub session: String,
    pub status: AgentStatus,
    pub preview: String,
}

#[derive(Resource, Default)]
pub struct AgentRegistry {
    pub agents: Vec<AgentData>,
    pub dirty: bool,
}

// --- Components ---

#[derive(Component)]
pub struct Agent {
    pub name: String,
    pub target: String,
    pub status: AgentStatus,
    pub char_index: usize,
}

#[derive(Component)]
pub struct AgentSprite;

#[derive(Component)]
pub struct AgentLabel;

#[derive(Component)]
pub struct StatusDot;

#[derive(Component)]
pub struct SaiyanGlow;

/// Sprite frame animation state
#[derive(Component)]
pub struct AnimationState {
    pub timer: Timer,
    pub frames: Vec<usize>,
    pub current: usize,
}

/// Grid position (tile coordinates within a room)
#[derive(Component, Clone)]
pub struct GridPosition {
    pub x: i32,
    pub y: i32,
    pub room_idx: usize,
}

/// Movement target
#[derive(Component)]
pub struct MoveTo {
    pub target: Vec2,
    pub speed: f32,
}

// --- Frame index helpers ---
// Atlas layout: 7 cols × 3 rows
// Row 0 = facing down, Row 1 = facing up, Row 2 = facing right (flip for left)
// Cols: 0-2 = walk frames, 3-4 = typing, 5-6 = reading

fn atlas_idx(row: usize, col: usize) -> usize {
    row * 7 + col
}

fn frames_for_status(status: &AgentStatus) -> (Vec<usize>, f32) {
    match status {
        AgentStatus::Busy => {
            // Typing animation: row 0, cols 3-4
            (vec![atlas_idx(0, 3), atlas_idx(0, 4)], 0.3)
        }
        AgentStatus::Ready => {
            // Idle: row 0, col 0 (static)
            (vec![atlas_idx(0, 0)], 1.0)
        }
        AgentStatus::Idle => {
            // Gentle walk cycle: row 0, cols 0,1,2,1
            (vec![atlas_idx(0, 0), atlas_idx(0, 1), atlas_idx(0, 2), atlas_idx(0, 1)], 0.4)
        }
        AgentStatus::Saiyan => {
            // Fast typing + glow: row 0, cols 3-4
            (vec![atlas_idx(0, 3), atlas_idx(0, 4)], 0.15)
        }
    }
}

// --- Systems ---

fn sync_agents(
    mut commands: Commands,
    mut registry: ResMut<AgentRegistry>,
    office: Res<OfficeMap>,
    sprite_assets: Option<Res<SpriteAssets>>,
    existing: Query<(Entity, &Agent)>,
) {
    if !registry.dirty {
        return;
    }
    registry.dirty = false;

    let Some(sprite_assets) = sprite_assets else { return };

    // Remove agents no longer in registry
    for (entity, agent) in existing.iter() {
        if !registry.agents.iter().any(|a| a.target == agent.target) {
            commands.entity(entity).despawn();
        }
    }

    // Update or spawn agents
    for (idx, data) in registry.agents.iter().enumerate() {
        let existing_entity = existing.iter().find(|(_, a)| a.target == data.target);

        let char_index = idx % sprite_assets.characters.len();

        if let Some((entity, _)) = existing_entity {
            // Update status
            commands.entity(entity).insert(Agent {
                name: data.name.clone(),
                target: data.target.clone(),
                status: data.status.clone(),
                char_index,
            });
        } else {
            // Find room and desk assignment
            let (room_idx, desk_pos) = find_desk_for_agent(&office, &data.session, idx);
            let room = &office.rooms[room_idx];
            let world_pos = room.world_pos(desk_pos.0 + 1, desk_pos.1);

            let (frames, speed) = frames_for_status(&data.status);

            // Spawn agent entity with sprite children
            commands.spawn((
                Agent {
                    name: data.name.clone(),
                    target: data.target.clone(),
                    status: data.status.clone(),
                    char_index,
                },
                GridPosition { x: desk_pos.0 + 1, y: desk_pos.1, room_idx },
                Transform::from_xyz(world_pos.x, world_pos.y, 5.0),
                Visibility::default(),
                InheritedVisibility::default(),
                ViewVisibility::default(),
                GlobalTransform::default(),
            )).with_children(|parent| {
                // Character sprite using Sprite::from_atlas_image (Bevy 0.15 API)
                let mut sprite = Sprite::from_atlas_image(
                    sprite_assets.characters[char_index].clone(),
                    TextureAtlas {
                        layout: sprite_assets.atlas_layout.clone(),
                        index: frames[0],
                    },
                );
                sprite.custom_size = Some(Vec2::new(SCALED_TILE, SCALED_TILE * 2.0));

                parent.spawn((
                    sprite,
                    Transform::from_xyz(0.0, SCALED_TILE * 0.5, 0.0),
                    AgentSprite,
                    AnimationState {
                        timer: Timer::from_seconds(speed, TimerMode::Repeating),
                        frames,
                        current: 0,
                    },
                ));

                // Name label below
                parent.spawn((
                    Text2d::new(&data.name),
                    TextFont {
                        font_size: 12.0,
                        ..default()
                    },
                    TextColor(Color::WHITE.with_alpha(0.8)),
                    Transform::from_xyz(0.0, -SCALED_TILE * 0.3, 1.0),
                    AgentLabel,
                ));

                // Status dot (top-right of character)
                parent.spawn((
                    Sprite {
                        color: colors::status_color(match &data.status {
                            AgentStatus::Busy | AgentStatus::Saiyan => "busy",
                            AgentStatus::Ready => "ready",
                            _ => "idle",
                        }),
                        custom_size: Some(Vec2::splat(8.0)),
                        ..default()
                    },
                    Transform::from_xyz(SCALED_TILE * 0.4, SCALED_TILE * 1.3, 2.0),
                    StatusDot,
                ));

                // Saiyan glow
                if data.status == AgentStatus::Saiyan {
                    parent.spawn((
                        Sprite {
                            color: Color::srgba(1.0, 0.85, 0.0, 0.15),
                            custom_size: Some(Vec2::new(SCALED_TILE * 1.4, SCALED_TILE * 2.4)),
                            ..default()
                        },
                        Transform::from_xyz(0.0, SCALED_TILE * 0.5, -0.5),
                        SaiyanGlow,
                    ));
                }
            });
        }
    }
}

fn find_desk_for_agent(office: &OfficeMap, session: &str, agent_idx: usize) -> (usize, (i32, i32)) {
    let room_idx = office.rooms.iter()
        .position(|r| r.name.to_lowercase() == session.to_lowercase())
        .unwrap_or(agent_idx % office.rooms.len());

    let room = &office.rooms[room_idx];
    let desk_idx = agent_idx % room.desks.len().max(1);
    let desk = if room.desks.is_empty() {
        (2, 2)
    } else {
        room.desks[desk_idx]
    };

    (room_idx, desk)
}

fn animate_sprite_frames(
    time: Res<Time>,
    agents: Query<(&Agent, &Children)>,
    mut sprites: Query<(&mut AnimationState, &mut Sprite), With<AgentSprite>>,
) {
    for (agent, children) in agents.iter() {
        for &child in children.iter() {
            if let Ok((mut anim, mut sprite)) = sprites.get_mut(child) {
                // Update frames if status changed
                let (new_frames, new_speed) = frames_for_status(&agent.status);
                if anim.frames != new_frames {
                    anim.frames = new_frames;
                    anim.current = 0;
                    anim.timer = Timer::from_seconds(new_speed, TimerMode::Repeating);
                }

                anim.timer.tick(time.delta());
                if anim.timer.just_finished() {
                    anim.current = (anim.current + 1) % anim.frames.len();
                    if let Some(atlas) = &mut sprite.texture_atlas {
                        atlas.index = anim.frames[anim.current];
                    }
                }
            }
        }
    }
}

fn agent_movement(
    time: Res<Time>,
    mut agents: Query<(&mut Transform, &MoveTo), (With<Agent>, Without<AgentSprite>)>,
) {
    for (mut transform, move_to) in agents.iter_mut() {
        let current = transform.translation.truncate();
        let direction = move_to.target - current;
        let distance = direction.length();

        if distance < 1.0 {
            transform.translation.x = move_to.target.x;
            transform.translation.y = move_to.target.y;
            continue;
        }

        let step = direction.normalize() * move_to.speed * time.delta_secs();
        if step.length() >= distance {
            transform.translation.x = move_to.target.x;
            transform.translation.y = move_to.target.y;
        } else {
            transform.translation.x += step.x;
            transform.translation.y += step.y;
        }
    }
}

fn animate_status_indicators(
    time: Res<Time>,
    mut glows: Query<&mut Sprite, With<SaiyanGlow>>,
) {
    for mut sprite in glows.iter_mut() {
        let alpha = 0.10 + (time.elapsed_secs() * 3.0).sin().abs() * 0.15;
        sprite.color = Color::srgba(1.0, 0.85, 0.0, alpha);
    }
}
