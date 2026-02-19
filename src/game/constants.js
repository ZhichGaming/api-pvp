// ──────────────────────────────────────────────
// Game Constants
// ──────────────────────────────────────────────

module.exports = {
  // Arena
  ARENA_WIDTH: 40,
  ARENA_HEIGHT: 30,

  // Tick
  TICK_RATE: 20,                 // ticks per second
  TICK_INTERVAL_MS: 50,          // ms per tick

  // Player defaults
  PLAYER_HP: 100,
  PLAYER_AMMO: 5,
  PLAYER_MAX_AMMO: 5,
  PLAYER_SPEED: 1.5,              // units per action
  PLAYER_SIZE: 0.5,              // collision radius

  // Combat
  BULLET_DAMAGE: 25,
  BULLET_SPEED: 5,               // units per tick (increased for faster bullets)
  BULLET_MAX_LIFETIME_TICKS: 50, // 2.5 seconds at 20 TPS (increased for more range)
  MAX_BULLETS_PER_PLAYER: 5,

  // Reload
  RELOAD_AMOUNT: 5,              // full reload
  RELOAD_COOLDOWN_TICKS: 10,     // 0.5s cooldown

  // Rate limiting
  MAX_ACTIONS_PER_SECOND: 20,

  // Battle
  MAX_BATTLE_DURATION_TICKS: 2400, // 2 minutes at 20 TPS

  // Directions map
  DIRECTIONS: {
    up:    { x:  0, y: -1 },
    down:  { x:  0, y:  1 },
    left:  { x: -1, y:  0 },
    right: { x:  1, y:  0 },
  },

  // Game modes
  MODE_TEST: 'test',
  MODE_BATTLE: 'battle',
  MODE_LOBBY: 'lobby',
  MODE_FINISHED: 'finished',

  // Obstacle types
  OBSTACLE_WALL: 'wall',
  OBSTACLE_CRATE: 'crate',
};
