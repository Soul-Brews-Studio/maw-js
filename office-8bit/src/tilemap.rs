use bevy::prelude::*;
use crate::colors;

pub struct TilemapPlugin;

impl Plugin for TilemapPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(OfficeMap::default())
            .add_systems(Startup, (load_tile_assets, spawn_world).chain());
    }
}

pub const TILE_SIZE: f32 = 16.0;
pub const TILE_SCALE: f32 = 4.0;
pub const SCALED_TILE: f32 = TILE_SIZE * TILE_SCALE; // 64px display

// World dimensions (in tiles)
pub const WORLD_W: i32 = 40;
pub const WORLD_H: i32 = 32;

// --- Tile assets ---

#[derive(Resource)]
pub struct TileAssets {
    pub tileset: Handle<Image>,
    pub tile_layout: Handle<TextureAtlasLayout>,
    pub tree: Handle<Image>,
    pub grass: Handle<Image>,
    pub path: Handle<Image>,
    pub water: Handle<Image>,
    pub mountain: Handle<Image>,
}

// Tileset atlas indices (dark theme = columns 5-9)
// room3.png: 240×64, 15 cols × 4 rows, tile 16×16
mod tile_idx {
    const DARK_COL: usize = 5;
    const COLS: usize = 15;

    pub const fn dark(row: usize, col: usize) -> usize {
        row * COLS + DARK_COL + col
    }

    pub const WALL_TOP_LEFT: usize = dark(0, 0);
    pub const WALL_TOP: usize = dark(0, 1);
    pub const WALL_TOP_RIGHT: usize = dark(0, 2);
    pub const WALL_LEFT: usize = dark(1, 0);
    pub const WALL_RIGHT: usize = dark(1, 2);
    pub const WALL_BOTTOM_LEFT: usize = dark(2, 0);
    pub const WALL_BOTTOM: usize = dark(2, 1);
    pub const WALL_BOTTOM_RIGHT: usize = dark(2, 2);

    pub const FLOOR: usize = dark(3, 1);
    pub const FLOOR_ALT: usize = dark(3, 2);

    pub const DESK: usize = dark(3, 3);
    pub const CHAIR: usize = dark(3, 0);
}

fn load_tile_assets(
    mut commands: Commands,
    asset_server: Res<AssetServer>,
    mut atlas_layouts: ResMut<Assets<TextureAtlasLayout>>,
) {
    let tileset = asset_server.load("tiles/room3.png");
    let tree = asset_server.load("tiles/tree.png");
    let grass = asset_server.load("tiles/grass.png");
    let path = asset_server.load("tiles/path.png");
    let water = asset_server.load("tiles/water.png");
    let mountain = asset_server.load("tiles/mountain.png");

    let tile_layout = atlas_layouts.add(
        TextureAtlasLayout::from_grid(UVec2::new(16, 16), 15, 4, None, None)
    );

    commands.insert_resource(TileAssets {
        tileset,
        tile_layout,
        tree,
        grass,
        path,
        water,
        mountain,
    });
}

// --- Tile types ---

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TileKind {
    Void,
    Grass,
    Path,
    Floor,
    Wall,
    Door,
    Desk,
    Chair,
    Plant,
    Mountain,
    Water,
}

impl TileKind {
    pub fn is_walkable(&self) -> bool {
        matches!(self, TileKind::Grass | TileKind::Path | TileKind::Floor | TileKind::Door | TileKind::Chair)
    }
}

// --- Room ---

#[derive(Clone, Debug)]
pub struct Room {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub tiles: Vec<Vec<TileKind>>,
    pub desks: Vec<(i32, i32)>,
    pub door: (i32, i32), // door position (local coords)
}

impl Room {
    pub fn new(name: &str, x: i32, y: i32, width: i32, height: i32) -> Self {
        let mut tiles = vec![vec![TileKind::Floor; width as usize]; height as usize];

        // Walls on edges
        for col in 0..width as usize {
            tiles[0][col] = TileKind::Wall;
            tiles[height as usize - 1][col] = TileKind::Wall;
        }
        for row in 0..height as usize {
            tiles[row][0] = TileKind::Wall;
            tiles[row][width as usize - 1] = TileKind::Wall;
        }

        // Door at bottom center
        let door_col = width / 2;
        let door_row = height - 1;
        tiles[door_row as usize][door_col as usize] = TileKind::Door;

        // Place desks — more positions to avoid stacking
        let mut desks = Vec::new();
        // Multiple desk columns spread across the room
        let mut desk_cols = vec![2];
        if width > 6 { desk_cols.push(width / 2); }
        if width > 8 { desk_cols.push(width - 3); }

        for &col in &desk_cols {
            if col < 1 || col >= width - 1 { continue; }
            for row in (2..height - 1).step_by(2) {
                tiles[row as usize][col as usize] = TileKind::Desk;
                if col + 1 < width - 1 {
                    tiles[row as usize][(col + 1) as usize] = TileKind::Chair;
                }
                desks.push((col, row));
            }
        }

        // Plants in corners
        if width > 4 && height > 4 {
            tiles[1][1] = TileKind::Plant;
            tiles[1][width as usize - 2] = TileKind::Plant;
        }

        Room {
            name: name.to_string(), x, y, width, height, tiles, desks,
            door: (door_col, door_row),
        }
    }

    pub fn world_pos(&self, local_x: i32, local_y: i32) -> Vec2 {
        Vec2::new(
            (self.x + local_x) as f32 * SCALED_TILE,
            -(self.y + local_y) as f32 * SCALED_TILE,
        )
    }
}

// --- Office map ---

#[derive(Resource)]
pub struct OfficeMap {
    pub rooms: Vec<Room>,
    pub spawned: bool,
    pub world: Vec<Vec<TileKind>>, // full outdoor world grid
}

impl Default for OfficeMap {
    fn default() -> Self {
        // Rooms placed on the world map (leaving space around for outdoor)
        let rooms = vec![
            Room::new("Oracles",  3,  3, 12, 10),
            Room::new("Brewing", 18,  3, 11, 10),
            Room::new("Tools",    3, 16, 12, 9),
            Room::new("Watchers",18, 16, 11, 9),
        ];

        // Build world grid
        let mut world = vec![vec![TileKind::Grass; WORLD_W as usize]; WORLD_H as usize];

        // Mountains along top edge
        for col in 0..WORLD_W as usize {
            world[0][col] = TileKind::Mountain;
            world[1][col] = TileKind::Mountain;
            if col % 3 != 0 { world[2][col] = TileKind::Mountain; }
        }

        // Mountains along left and right edges
        for row in 0..WORLD_H as usize {
            world[row][0] = TileKind::Mountain;
            world[row][1] = TileKind::Mountain;
            world[row][WORLD_W as usize - 1] = TileKind::Mountain;
            world[row][WORLD_W as usize - 2] = TileKind::Mountain;
        }

        // Water pond (bottom-right)
        for row in 25..29 {
            for col in 30..36 {
                if row < WORLD_H as usize && col < WORLD_W as usize {
                    world[row][col] = TileKind::Water;
                }
            }
        }

        // Paths connecting rooms
        // Horizontal path between room pairs
        for col in 3..30 {
            world[12][col] = TileKind::Path; // between top and bottom rooms
            world[13][col] = TileKind::Path;
        }
        // Vertical paths to room doors
        for row in 10..15 {
            world[row][9] = TileKind::Path;  // left rooms
            world[row][22] = TileKind::Path; // right rooms
        }
        // Path from spawn area
        for row in 13..24 {
            world[row][15] = TileKind::Path; // center vertical path
            world[row][16] = TileKind::Path;
        }

        // Stamp room tiles onto world grid
        for room in &rooms {
            for (ry, row) in room.tiles.iter().enumerate() {
                for (rx, tile) in row.iter().enumerate() {
                    let wx = room.x as usize + rx;
                    let wy = room.y as usize + ry;
                    if wy < WORLD_H as usize && wx < WORLD_W as usize {
                        world[wy][wx] = *tile;
                    }
                }
            }
        }

        OfficeMap { rooms, spawned: false, world }
    }
}

// --- Components ---

#[derive(Component)]
pub struct TileEntity;

#[derive(Component)]
pub struct RoomLabel;

// --- Wall classification ---

enum WallPos { TopLeft, Top, TopRight, Left, Right, BottomLeft, Bottom, BottomRight }

fn classify_wall(col: i32, row: i32, room: &Room) -> WallPos {
    let lx = col - room.x;
    let ly = row - room.y;
    let is_top = ly == 0;
    let is_bottom = ly == room.height - 1;
    let is_left = lx == 0;
    let is_right = lx == room.width - 1;

    match (is_top, is_bottom, is_left, is_right) {
        (true, _, true, _) => WallPos::TopLeft,
        (true, _, _, true) => WallPos::TopRight,
        (true, _, _, _) => WallPos::Top,
        (_, true, true, _) => WallPos::BottomLeft,
        (_, true, _, true) => WallPos::BottomRight,
        (_, true, _, _) => WallPos::Bottom,
        (_, _, true, _) => WallPos::Left,
        (_, _, _, true) => WallPos::Right,
        _ => WallPos::Top,
    }
}

fn wall_atlas_index(wall_pos: WallPos) -> usize {
    match wall_pos {
        WallPos::TopLeft => tile_idx::WALL_TOP_LEFT,
        WallPos::Top => tile_idx::WALL_TOP,
        WallPos::TopRight => tile_idx::WALL_TOP_RIGHT,
        WallPos::Left => tile_idx::WALL_LEFT,
        WallPos::Right => tile_idx::WALL_RIGHT,
        WallPos::BottomLeft => tile_idx::WALL_BOTTOM_LEFT,
        WallPos::Bottom => tile_idx::WALL_BOTTOM,
        WallPos::BottomRight => tile_idx::WALL_BOTTOM_RIGHT,
    }
}

// --- Spawn ---

fn spawn_world(
    mut commands: Commands,
    mut office: ResMut<OfficeMap>,
    tile_assets: Option<Res<TileAssets>>,
) {
    if office.spawned { return; }
    let Some(tile_assets) = tile_assets else { return };
    office.spawned = true;

    // Render entire world grid
    for wy in 0..WORLD_H as usize {
        for wx in 0..WORLD_W as usize {
            let tile = office.world[wy][wx];
            if tile == TileKind::Void { continue; }

            let pos = Vec2::new(wx as f32 * SCALED_TILE, -(wy as f32) * SCALED_TILE);

            match tile {
                TileKind::Grass => {
                    // Lush green with variation
                    let v = ((wx * 7 + wy * 13) % 5) as f32;
                    let g = 0.32 + v * 0.03;
                    spawn_color_tile(&mut commands, Color::srgb(0.14, g, 0.12), pos, -2.0);
                }
                TileKind::Path => {
                    let v = ((wx + wy) % 3) as f32 * 0.02;
                    spawn_color_tile(&mut commands, Color::srgb(0.55 + v, 0.45 + v, 0.30), pos, -1.5);
                }
                TileKind::Mountain => {
                    let v = ((wx * 3 + wy * 5) % 4) as f32 * 0.03;
                    let base = 0.20 + (wy as f32 * 0.01).min(0.15);
                    spawn_color_tile(&mut commands, Color::srgb(base + v, base + v + 0.02, base + v + 0.05), pos, -1.0);
                    if wy <= 1 && wx % 4 < 2 {
                        commands.spawn((
                            Sprite {
                                color: Color::srgba(0.85, 0.88, 0.92, 0.7),
                                custom_size: Some(Vec2::new(SCALED_TILE * 0.6, SCALED_TILE * 0.3)),
                                ..default()
                            },
                            Transform::from_xyz(pos.x, pos.y + SCALED_TILE * 0.3, -0.5),
                        ));
                    }
                }
                TileKind::Water => {
                    let v = ((wx + wy) % 2) as f32 * 0.04;
                    spawn_color_tile(&mut commands, Color::srgb(0.10, 0.25 + v, 0.55 + v), pos, -1.0);
                }
                TileKind::Plant => {
                    // Grass underneath
                    spawn_color_tile(&mut commands, Color::srgb(0.14, 0.34, 0.12), pos, -2.0);
                    // Tree sprite on top
                    let mut tree_sprite = Sprite::from_image(tile_assets.tree.clone());
                    tree_sprite.custom_size = Some(Vec2::splat(SCALED_TILE));
                    commands.spawn((
                        tree_sprite,
                        Transform::from_xyz(pos.x, pos.y, 3.0),
                        TileEntity,
                    ));
                }
                TileKind::Door => {
                    // Walkable door tile - darker floor to indicate entrance
                    commands.spawn((
                        Sprite {
                            color: Color::srgb(0.22, 0.18, 0.12),
                            custom_size: Some(Vec2::splat(SCALED_TILE)),
                            ..default()
                        },
                        Transform::from_xyz(pos.x, pos.y, 0.0),
                        TileEntity,
                    ));
                }
                TileKind::Wall => {
                    // Find which room this wall belongs to for proper atlas index
                    let room_opt = office.rooms.iter().find(|r| {
                        let lx = wx as i32 - r.x;
                        let ly = wy as i32 - r.y;
                        lx >= 0 && lx < r.width && ly >= 0 && ly < r.height
                    });

                    if let Some(room) = room_opt {
                        let wall_pos = classify_wall(wx as i32, wy as i32, room);
                        let atlas_index = wall_atlas_index(wall_pos);

                        let mut sprite = Sprite::from_atlas_image(
                            tile_assets.tileset.clone(),
                            TextureAtlas {
                                layout: tile_assets.tile_layout.clone(),
                                index: atlas_index,
                            },
                        );
                        sprite.custom_size = Some(Vec2::splat(SCALED_TILE));

                        commands.spawn((
                            sprite,
                            Transform::from_xyz(pos.x, pos.y, 1.0),
                            TileEntity,
                        ));
                    }
                }
                TileKind::Floor | TileKind::Desk | TileKind::Chair => {
                    let atlas_index = match tile {
                        TileKind::Desk => tile_idx::DESK,
                        TileKind::Chair => tile_idx::CHAIR,
                        _ => {
                            if (wx + wy) % 3 == 0 { tile_idx::FLOOR_ALT } else { tile_idx::FLOOR }
                        }
                    };

                    let mut sprite = Sprite::from_atlas_image(
                        tile_assets.tileset.clone(),
                        TextureAtlas {
                            layout: tile_assets.tile_layout.clone(),
                            index: atlas_index,
                        },
                    );
                    sprite.custom_size = Some(Vec2::splat(SCALED_TILE));

                    commands.spawn((
                        sprite,
                        Transform::from_xyz(pos.x, pos.y, 0.0),
                        TileEntity,
                    ));
                }
                _ => {}
            }
        }
    }

    // Fill remaining void with grass (outside world bounds already blocked by collision)

    // Scatter trees on grass areas
    let tree_positions = [
        (3, 7), (3, 16), (3, 24),
        (15, 2), (16, 5), (28, 4), (30, 7),
        (32, 14), (34, 16), (35, 20),
        (3, 28), (8, 25), (28, 24), (33, 26),
        (15, 26), (25, 28),
    ];
    for (tx, ty) in tree_positions {
        if tx < WORLD_W as usize && ty < WORLD_H as usize {
            if office.world[ty][tx] == TileKind::Grass {
                let pos = Vec2::new(tx as f32 * SCALED_TILE, -(ty as f32) * SCALED_TILE);
                let mut tree_sprite = Sprite::from_image(tile_assets.tree.clone());
                tree_sprite.custom_size = Some(Vec2::splat(SCALED_TILE * 1.2));
                commands.spawn((
                    tree_sprite,
                    Transform::from_xyz(pos.x, pos.y, 3.0),
                    TileEntity,
                ));
            }
        }
    }

    // Room labels above doors
    for room in &office.rooms {
        let room_color = colors::room_color(&room.name);
        let label_pos = Vec2::new(
            (room.x as f32 + room.width as f32 / 2.0) * SCALED_TILE,
            -(room.y as f32 - 0.8) * SCALED_TILE,
        );
        commands.spawn((
            Text2d::new(&room.name),
            TextFont { font_size: 18.0, ..default() },
            TextColor(room_color),
            Transform::from_xyz(label_pos.x, label_pos.y, 10.0),
            RoomLabel,
        ));
    }
}

fn spawn_color_tile(commands: &mut Commands, color: Color, pos: Vec2, z: f32) {
    commands.spawn((
        Sprite {
            color,
            custom_size: Some(Vec2::splat(SCALED_TILE + 1.0)),
            ..default()
        },
        Transform::from_xyz(pos.x, pos.y, z),
        TileEntity,
    ));
}
