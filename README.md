# API PVP Arena

A server-authoritative real-time top-down arena where players control characters through API requests.

## Deploy to Railway (recommended)

Railway runs persistent Node.js servers — required for the WebSocket game loop.

1. Push this repo to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
3. Select this repo. Railway auto-detects Node.js and runs `npm start`.
4. Click **Generate Domain** under Settings → Networking to get a public URL.

That's it. No extra configuration needed — `railway.toml` is already included.

> **Why not Vercel?**  
> Vercel is serverless — functions spin up per request and share no memory between calls.  
> This app needs a *persistent process* for the in-memory game state and the 20 TPS `setInterval` game loop. Railway, Render, and Fly.io all fit that model.

### Alternative: Render

1. New **Web Service** → connect GitHub repo.
2. Build command: `npm install`
3. Start command: `npm start`

### Alternative: Fly.io

```bash
npm install -g flyctl
flyctl launch   # auto-detects Node.js
flyctl deploy
```

---

## Local Development

```bash
npm install
npm start          # production
npm run dev        # watch mode (auto-restart on changes)
```

Server starts at **http://localhost:3000**

## Views

| URL | Description |
|-----|-------------|
| `http://localhost:3000/bigscreen` | Full arena view (for projector/big screen) |
| `http://localhost:3000/monitor` | Player monitor (zoomed-in, per-player) |

## API Endpoints

### `POST /register` — Register a player
```json
{ "username": "Alice" }
// → { "player_id": "p_a1b2c3d4", "username": "Alice", "position": { "x": 10, "y": 15 } }
```

### `POST /action` — Submit an action
```json
{ "player_id": "p_a1b2c3d4", "action": "move", "direction": "up" }
// Actions: move, shoot, reload
// Directions: up, down, left, right
// move/shoot can also use: { "angle": 45 }
```

### `GET /state` — Get game state
```
GET /state                        → full arena state
GET /state?player_id=p_a1b2c3d4   → zoomed-in player state
```

### `POST /ready` — Signal ready for battle
```json
{ "player_id": "p_a1b2c3d4" }
```

### `POST /start` — Start battle mode
```json
// No payload needed
```

### `POST /reset` — Reset all players to sandbox mode
```json
// No payload needed
```

### `GET /debug` — Debug info (collisions, bullets, HP, cooldowns)

### `GET /players` — List all players

### `DELETE /player/:id` — Remove a player

## Game Mechanics

| Stat | Default |
|------|---------|
| HP | 100 |
| Ammo | 5 |
| Bullet Damage | 25 HP |
| Bullet Speed | 2 units/tick |
| Bullet Lifetime | 50 ticks (2.5 sec) |
| Max bullets per player | 5 |
| Reload cooldown | 10 ticks (0.5 sec) |
| Tick Rate | 20 TPS (50ms per tick) |
| Rate Limit | 30 actions/sec per player |

## Game Flow

### Test Mode
1. Register → `POST /register`
2. Move around → `POST /action` with `move`
3. Practice shooting and reloading
4. Signal ready → `POST /ready`

### Battle Mode
1. Host starts → `POST /start`
2. Server runs 20 ticks/sec
3. Actions processed simultaneously per tick
4. State broadcast via WebSocket
5. Last alive or highest HP after 2 min wins

## Example Bot (curl)

```bash
# Register
curl -X POST http://localhost:3000/register \
  -H "Content-Type: application/json" \
  -d '{"username": "Bot1"}'

# Move
curl -X POST http://localhost:3000/action \
  -H "Content-Type: application/json" \
  -d '{"player_id": "p_YOURID", "action": "move", "direction": "right"}'

# Shoot
curl -X POST http://localhost:3000/action \
  -H "Content-Type: application/json" \
  -d '{"player_id": "p_YOURID", "action": "shoot", "direction": "up"}'

# Reload
curl -X POST http://localhost:3000/action \
  -H "Content-Type: application/json" \
  -d '{"player_id": "p_YOURID", "action": "reload"}'
```

## WebSocket

Connect to `ws://localhost:3000?type=bigscreen` for full arena state, or `ws://localhost:3000?type=player&player_id=p_YOURID` for player-specific state.

Messages are JSON: `{ "type": "state", "data": { ... } }`

For full request/response details, see `/docs/API.md`.
