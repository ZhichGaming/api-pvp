/**
 * API PVP — Keyboard Control Client
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure vanilla JS. No framework, no build step. Zero dependencies.
 *
 * Architecture overview
 * ─────────────────────
 * 1.  SETUP        — captures serverUrl + username, calls POST /register
 * 2.  STATE POLLER — calls GET /state?player_id=… every 200ms to keep
 *                    local stats (hp, ammo, energy, mode) up-to-date
 * 3.  KEYBOARD     — maps keys → actions; all keydown events funnel into
 *                    sendAction(), which checks local state before firing
 * 4.  ACTION QUEUE — some actions (reload, dash) have server-side cooldowns;
 *                    we detect "cooldown active" errors and retry after 80ms
 * 5.  SMART GATES  — blocks actions the server would reject anyway:
 *                      • shoot  → blocked when ammo === 0
 *                      • shield → blocked when energy < 5
 *                      • dash   → blocked when energy < 8
 *                    This saves a round-trip and keeps the log clean.
 * 6.  HUD          — updates bars / pips / indicators on every poll tick
 */

// ── Config ────────────────────────────────────────────────────────────────────
const DEFAULT_SERVER = 'https://api-pvp-production.up.railway.app';
const POLL_INTERVAL_MS = 200;   // how often we fetch /state
const ACTION_RETRY_MS  = 80;    // how long to wait before retrying a queued action
const MAX_LOG_ENTRIES  = 120;

// Costs (must match server constants.js)
const COST_SHIELD = 5;
const COST_DASH   = 8;
const MAX_AMMO    = 5;

// ── State ─────────────────────────────────────────────────────────────────────
let serverUrl  = DEFAULT_SERVER;
let playerId   = null;
let playerName = '';

// Cached stat values — updated by the poller so we can gate actions locally
let localState = {
  hp:          100,
  ammo:        MAX_AMMO,
  energy:      25,
  kills:       0,
  alive:       true,
  shielded:    false,
  reloadCd:    false,   // true while reload cooldown is active
  mode:        'test',
};

// Which direction was last used for movement (used for dash without re-typing dir)
let lastMoveDir  = 'up';
// Which direction was last used for shooting (Space fires in last shoot direction)
let lastShootDir = 'up';

let pollTimer    = null;    // setInterval handle for state polling
let pendingRetry = null;    // setTimeout handle for action retry queue

// ── DOM references ────────────────────────────────────────────────────────────
const setupScreen   = document.getElementById('setup-screen');
const gameScreen    = document.getElementById('game-screen');
const serverInput   = document.getElementById('server-url');
const usernameInput = document.getElementById('username');
const registerBtn   = document.getElementById('register-btn');
const setupError    = document.getElementById('setup-error');

const displayName   = document.getElementById('display-name');
const playerIdEl    = document.getElementById('player-id-display');
const modeBadge     = document.getElementById('mode-badge');

const barHp         = document.getElementById('bar-hp');
const barEnergy     = document.getElementById('bar-energy');
const ammoPips      = document.getElementById('ammo-pips');
const valHp         = document.getElementById('val-hp');
const valAmmo       = document.getElementById('val-ammo');
const valEnergy     = document.getElementById('val-energy');
const valKills      = document.getElementById('val-kills');

const indShield     = document.getElementById('ind-shield');
const indReload     = document.getElementById('ind-reload');
const indDead       = document.getElementById('ind-dead');
const lastActionEl  = document.getElementById('last-action');
const actionLog     = document.getElementById('action-log');

const linkBigscreen = document.getElementById('link-bigscreen');
const linkMonitor   = document.getElementById('link-monitor');
const linkApi       = document.getElementById('link-api');

// Key box elements — lit up on press
const KEY_BOXES = {
  w:     document.getElementById('k-w'),
  a:     document.getElementById('k-a'),
  s:     document.getElementById('k-s'),
  d:     document.getElementById('k-d'),
  up:    document.getElementById('k-up'),
  left:  document.getElementById('k-left'),
  down:  document.getElementById('k-down'),
  right: document.getElementById('k-right'),
  space: document.getElementById('k-space'),
  shift: document.getElementById('k-shift'),
  r:     document.getElementById('k-r'),
  f:     document.getElementById('k-f'),
};

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════

registerBtn.addEventListener('click', doRegister);
document.getElementById('disconnect-btn').addEventListener('click', doDisconnect);
document.getElementById('clear-log').addEventListener('click', () => actionLog.innerHTML = '');

// Allow Enter key in setup inputs
[serverInput, usernameInput].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
});

async function doRegister() {
  const url  = (serverInput.value || DEFAULT_SERVER).replace(/\/$/, '');
  const name = usernameInput.value.trim();

  if (!name) { showSetupError('Enter a username'); return; }

  serverUrl = url;
  registerBtn.disabled = true;
  registerBtn.textContent = 'Registering…';
  hideSetupError();

  try {
    const res  = await apiFetch('/register', 'POST', { username: name });
    const data = await res.json();

    if (!res.ok) {
      showSetupError(data.error || 'Registration failed');
      return;
    }

    // Success — store identity and switch to game screen
    playerId   = data.player_id;
    playerName = data.username;
    enterGame();

  } catch (e) {
    showSetupError('Cannot reach server: ' + (e.message || 'network error'));
  } finally {
    registerBtn.disabled = false;
    registerBtn.textContent = 'Register & Connect';
  }
}

function enterGame() {
  // Update server links
  linkBigscreen.href = `${serverUrl}/bigscreen`;
  linkMonitor.href   = `${serverUrl}/monitor?player_id=${encodeURIComponent(playerId)}`;
  linkApi.href       = `${serverUrl}/players`;

  displayName.textContent  = playerName;
  playerIdEl.textContent   = playerId;

  setupScreen.classList.remove('active');
  gameScreen.classList.add('active');

  startPoller();
  addLog(`Registered as ${playerName} (${playerId})`, 'ok');
  addLog(`Server: ${serverUrl}`, 'info');
  addLog('Focus window and use keys to play', 'info');
}

function doDisconnect() {
  stopPoller();
  playerId   = null;
  playerName = '';
  gameScreen.classList.remove('active');
  setupScreen.classList.add('active');
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE POLLER
// Keeps localState in sync with the server — no rendering, just stat tracking.
// ══════════════════════════════════════════════════════════════════════════════

function startPoller() {
  stopPoller();
  pollTimer = setInterval(pollState, POLL_INTERVAL_MS);
  pollState(); // immediate first fetch
}

function stopPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollState() {
  if (!playerId) return;
  try {
    const res  = await apiFetch(`/state?player_id=${encodeURIComponent(playerId)}`, 'GET');
    if (!res.ok) return;
    const data = await res.json();
    applyState(data);
  } catch (_) {
    // Network blip — silently ignore, we'll retry next tick
  }
}

/**
 * applyState(data)
 * Parses the /state response and updates localState + HUD.
 * The `data.self` object mirrors the Player class properties.
 */
function applyState(data) {
  if (!data.self) return;
  const s = data.self;

  localState.hp       = s.hp       ?? localState.hp;
  localState.ammo     = s.ammo     ?? localState.ammo;
  localState.energy   = s.energy   ?? localState.energy;
  localState.kills    = s.kills    ?? localState.kills;
  localState.alive    = s.alive    ?? localState.alive;
  localState.shielded = s.shielded ?? false;
  localState.reloadCd = s.reloadCooldown > 0;
  localState.mode     = data.mode  ?? localState.mode;

  updateHUD();
}

// ══════════════════════════════════════════════════════════════════════════════
// HUD
// ══════════════════════════════════════════════════════════════════════════════

function updateHUD() {
  const { hp, ammo, energy, kills, alive, shielded, reloadCd, mode } = localState;

  // HP bar
  const hpPct = Math.max(0, Math.min(100, hp));
  barHp.style.width = hpPct + '%';
  barHp.style.background = hpPct > 50 ? '#2ecc71' : hpPct > 25 ? '#f1c40f' : '#e74c3c';
  valHp.textContent = hp;

  // Energy bar
  const ePct = Math.max(0, Math.min(100, (energy / 25) * 100));
  barEnergy.style.width = ePct + '%';
  valEnergy.textContent = energy;

  // Ammo pips — rebuild if needed
  if (ammoPips.children.length !== MAX_AMMO) {
    ammoPips.innerHTML = '';
    for (let i = 0; i < MAX_AMMO; i++) {
      const pip = document.createElement('div');
      pip.className = 'pip';
      ammoPips.appendChild(pip);
    }
  }
  [...ammoPips.children].forEach((pip, i) => {
    pip.className = 'pip' + (i < ammo ? '' : ' empty');
  });
  valAmmo.textContent = `${ammo}/${MAX_AMMO}`;

  // Kills
  valKills.textContent = kills;

  // Mode badge
  const modeMap = {
    test:     ['SANDBOX',  'badge-sandbox'],
    sandbox:  ['SANDBOX',  'badge-sandbox'],
    lobby:    ['LOBBY',    'badge-lobby'],
    battle:   ['BATTLE',   'badge-battle'],
    finished: ['FINISHED', 'badge-finished'],
  };
  const [label, cls] = modeMap[mode] || ['—', 'badge-sandbox'];
  modeBadge.textContent  = label;
  modeBadge.className    = 'badge ' + cls;

  // Indicators
  indShield.classList.toggle('active', !!shielded);
  indReload.classList.toggle('active', !!reloadCd);
  indDead.classList.toggle('hidden', !!alive);
  if (!alive) indDead.classList.add('dead');
}

// ══════════════════════════════════════════════════════════════════════════════
// KEYBOARD HANDLING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Key → action mapping.
 *
 * move_*  — movement (WASD or arrow keys)
 * shoot_* — shoot in a direction (arrow keys while in "shoot mode")
 * shoot   — shoot in lastShootDir (Space)
 * shield  — hold shift
 * reload  — R
 * dash    — F (uses lastMoveDir as the dash direction)
 *
 * We use the arrow keys for BOTH shoot-direction and move.
 * Arrow keys alone → move. Space → shoot. Arrow+Space would be great
 * but browsers make that awkward, so: the arrow keys always move,
 * and Space fires in the last-moved direction. To shoot in a specific
 * direction without moving, hold Ctrl and press an arrow key.
 */
const KEY_MAP = {
  // WASD move
  'w':          { action: 'move',   direction: 'up'    },
  'a':          { action: 'move',   direction: 'left'  },
  's':          { action: 'move',   direction: 'down'  },
  'd':          { action: 'move',   direction: 'right' },
  // Arrow move (default)
  'ArrowUp':    { action: 'move',   direction: 'up'    },
  'ArrowLeft':  { action: 'move',   direction: 'left'  },
  'ArrowDown':  { action: 'move',   direction: 'down'  },
  'ArrowRight': { action: 'move',   direction: 'right' },
  // Space = shoot in last direction
  ' ':          { action: 'shoot',  direction: null     }, // direction filled at runtime
  // Shift = shield
  'Shift':      { action: 'shield', direction: null     },
  // R = reload
  'r':          { action: 'reload', direction: null     },
  // F = dash in last move direction
  'f':          { action: 'dash',   direction: null     }, // direction filled at runtime
  // Ctrl+Arrow = shoot in that direction without moving
  'ctrl+ArrowUp':    { action: 'shoot', direction: 'up'    },
  'ctrl+ArrowLeft':  { action: 'shoot', direction: 'left'  },
  'ctrl+ArrowDown':  { action: 'shoot', direction: 'down'  },
  'ctrl+ArrowRight': { action: 'shoot', direction: 'right' },
};

// Keys currently held down — used to prevent key repeat flooding
const heldKeys = new Set();

window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup',   handleKeyUp);

function handleKeyDown(e) {
  if (!playerId) return;

  // Don't fire actions when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Build key identifier (include ctrl modifier for shoot-arrows)
  const keyId = (e.ctrlKey ? 'ctrl+' : '') + e.key;

  // Ignore key-repeat (holding down a key triggers many events — let one through at a time)
  if (heldKeys.has(keyId)) return;
  heldKeys.add(keyId);

  // Prevent default browser scrolling for arrow/space keys
  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
  }

  const mapping = KEY_MAP[keyId];
  if (!mapping) return;

  // Highlight the key box
  flashKey(keyId);

  // Build the final action + direction
  let { action, direction } = mapping;

  if (action === 'move') {
    lastMoveDir  = direction;
    lastShootDir = direction; // shooting in last-moved direction makes sense as default
  }
  if (action === 'shoot' && direction === null) {
    direction = lastShootDir; // Space fires in last direction
  }
  if (action === 'dash' && direction === null) {
    direction = lastMoveDir;  // F dashes in last move direction
  }

  sendAction(action, direction);
}

function handleKeyUp(e) {
  const keyId = (e.ctrlKey ? 'ctrl+' : '') + e.key;
  heldKeys.delete(keyId);
  // Also remove bare key in case ctrlKey state changed
  heldKeys.delete(e.key);
}

// Map key identifiers to their visual kbox element
const KEY_BOX_MAP = {
  'w': KEY_BOXES.w, 'a': KEY_BOXES.a, 's': KEY_BOXES.s, 'd': KEY_BOXES.d,
  'ArrowUp': KEY_BOXES.up, 'ArrowLeft': KEY_BOXES.left,
  'ArrowDown': KEY_BOXES.down, 'ArrowRight': KEY_BOXES.right,
  'ctrl+ArrowUp': KEY_BOXES.up, 'ctrl+ArrowLeft': KEY_BOXES.left,
  'ctrl+ArrowDown': KEY_BOXES.down, 'ctrl+ArrowRight': KEY_BOXES.right,
  ' ': KEY_BOXES.space, 'Shift': KEY_BOXES.shift,
  'r': KEY_BOXES.r, 'f': KEY_BOXES.f,
};

function flashKey(keyId) {
  const el = KEY_BOX_MAP[keyId];
  if (!el) return;
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 120);
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTION SENDER
// Smart gates + retry queue
// ══════════════════════════════════════════════════════════════════════════════

/**
 * sendAction(action, direction)
 *
 * Before hitting the network we check local state to avoid sending actions
 * that the server would reject immediately. This keeps the log tidy and
 * prevents unnecessary 400s from cluttering the feed.
 *
 *  Action     Blocked when …
 *  ─────────  ────────────────────────────────────
 *  shoot      ammo === 0  (would get "no ammo" error)
 *  shield     energy < COST_SHIELD
 *  dash       energy < COST_DASH
 *  (any)      player is dead
 */
async function sendAction(action, direction) {
  if (!playerId) return;

  // ── Smart gate checks ──────────────────────────────────
  if (!localState.alive) {
    setLastAction('💀 You are dead', 'warn');
    return;
  }

  if (action === 'shoot' && localState.ammo <= 0) {
    setLastAction('⚠ No ammo — press R to reload', 'warn');
    return;
  }
  if (action === 'shield' && localState.energy < COST_SHIELD) {
    setLastAction(`⚠ Not enough energy (${localState.energy}/${COST_SHIELD})`, 'warn');
    return;
  }
  if (action === 'dash' && localState.energy < COST_DASH) {
    setLastAction(`⚠ Not enough energy for dash (${localState.energy}/${COST_DASH})`, 'warn');
    return;
  }
  if (action === 'reload' && localState.reloadCd) {
    // Reload on cooldown — queue a retry rather than dropping the request
    scheduleRetry(action, direction);
    setLastAction('⏳ Reload on cooldown — queued', 'warn');
    return;
  }

  // ── Send to server ─────────────────────────────────────
  const body = { player_id: playerId, action };
  if (direction) body.direction = direction;

  const dirStr = direction ? ` → ${direction}` : '';
  setLastAction(`${action}${dirStr} …`, 'info');

  try {
    const res  = await apiFetch('/action', 'POST', body);
    const data = await res.json();

    if (res.status === 429) {
      // Rate limited — retry shortly
      scheduleRetry(action, direction);
      addLog(`⏱ rate-limited — retrying`, 'warn');
      return;
    }

    if (!res.ok) {
      const msg = data.error || 'Unknown error';
      setLastAction(`✗ ${action}${dirStr}: ${msg}`, 'err');
      addLog(`✗ ${action}${dirStr}: ${msg}`, 'err');

      // If reload is on CD and we somehow missed it locally, retry
      if (msg.toLowerCase().includes('cooldown')) {
        scheduleRetry(action, direction);
      }
      return;
    }

    // Success — update local state from the action response (faster than waiting for poll)
    if (data.state?.self) applyState(data.state);

    setLastAction(`✓ ${action}${dirStr}`, 'ok');
    addLog(`✓ ${action}${dirStr}`, 'ok');

  } catch (e) {
    setLastAction(`✗ network error`, 'err');
  }
}

/**
 * scheduleRetry — attempts the action once after ACTION_RETRY_MS.
 * Only one retry is queued at a time (pendingRetry).
 */
function scheduleRetry(action, direction) {
  if (pendingRetry) return; // don't stack retries
  pendingRetry = setTimeout(() => {
    pendingRetry = null;
    sendAction(action, direction);
  }, ACTION_RETRY_MS);
}

// ══════════════════════════════════════════════════════════════════════════════
// API HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * apiFetch(path, method, body)
 * Thin wrapper around fetch that prepends the configured serverUrl.
 */
function apiFetch(path, method = 'GET', body = null) {
  const url = serverUrl + path;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

// ══════════════════════════════════════════════════════════════════════════════
// LOG + FEEDBACK HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function addLog(msg, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;

  const ts = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = `<span class="log-ts">${ts}</span>${escapeHtml(msg)}`;

  actionLog.prepend(entry);

  // Trim log
  while (actionLog.children.length > MAX_LOG_ENTRIES) {
    actionLog.removeChild(actionLog.lastChild);
  }
}

function setLastAction(msg, type = 'ok') {
  lastActionEl.textContent = msg;
  lastActionEl.className   = `last-action ${type}`;
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove('hidden');
}

function hideSetupError() {
  setupError.classList.add('hidden');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
