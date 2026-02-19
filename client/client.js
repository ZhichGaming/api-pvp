/**
 * API PVP — Keyboard + Aim Pad Control Client
 * ═══════════════════════════════════════════════════════════════════════════
 * Pure vanilla JS. No framework, no build step. Zero dependencies.
 *
 * Features
 * ────────
 * 1. WASD / arrow keys for movement
 * 2. Space fires a bullet at the current aim-pad angle (free angle, 0-359°)
 * 3. Arrow keys fire cardinal-direction shots (up/down/left/right)
 * 4. Aim pad: mouse move/drag over the circular pad → sets aimAngle
 *    Clicking the pad fires immediately
 * 5. Shift=shield, R=reload, F=dash
 * 6. Smart local gates: blocked actions logged without network round-trip
 * 7. State polling every 200ms for live HUD updates
 * 8. Action retry queue for rate-limit / cooldown errors
 */

// ── Config ────────────────────────────────────────────────────────────────────
const DEFAULT_SERVER    = 'https://api-pvp-production.up.railway.app';
const POLL_INTERVAL_MS  = 200;
const ACTION_RETRY_MS   = 80;
const MAX_LOG_ENTRIES   = 120;

const MAX_AMMO    = 5;
const MOVEMENT_TICK_MS  = 50; // Match server tick rate (50 ms) for continuous movement

// ── State ─────────────────────────────────────────────────────────────────────
let serverUrl  = DEFAULT_SERVER;
let playerId   = null;
let playerName = '';

let localState = {
  hp:       100,
  ammo:     MAX_AMMO,
  kills:    0,
  alive:    true,
  reloadCd: false,
  mode:     'test',
};

// Aim pad state — degrees, 0=right, 90=down (standard canvas coords)
let aimAngle     = 0;
let aimDragging  = false;

let lastMoveDir  = 'up';
let pollTimer    = null;
let pendingRetry = null;
let movementTimer = null;
let heldMovementKeys = new Set(); // Track which movement keys are held
let lastMovementKey = null; // Track most recent movement key pressed

// ── DOM refs ──────────────────────────────────────────────────────────────────
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
const ammoPips      = document.getElementById('ammo-pips');
const valHp         = document.getElementById('val-hp');
const valAmmo       = document.getElementById('val-ammo');
const valKills      = document.getElementById('val-kills');

const indReload     = document.getElementById('ind-reload');
const indDead       = document.getElementById('ind-dead');
const lastActionEl  = document.getElementById('last-action');
const actionLog     = document.getElementById('action-log');

const linkBigscreen = document.getElementById('link-bigscreen');
const linkMonitor   = document.getElementById('link-monitor');
const linkApi       = document.getElementById('link-api');

const aimPad        = document.getElementById('aim-pad');
const aimDot        = document.getElementById('aim-dot');
const aimLine       = document.getElementById('aim-line');
const aimAngleEl    = document.getElementById('aim-angle-display');

// Key boxes
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
  r:     document.getElementById('k-r'),
};

// ══════════════════════════════════════════════════════════════════════════════
// AIM PAD
// ══════════════════════════════════════════════════════════════════════════════

/**
 * setAimAngle(deg)
 * Updates the aim angle and re-positions the indicator dot/line.
 */
function setAimAngle(deg) {
  aimAngle = ((deg % 360) + 360) % 360;
  const rad = aimAngle * Math.PI / 180;
  const r   = 28; // radius of dot travel from center (px)
  const cx  = 40; // pad center x
  const cy  = 40; // pad center y
  const dotX = cx + r * Math.cos(rad);
  const dotY = cy + r * Math.sin(rad);
  aimDot.style.left = dotX + 'px';
  aimDot.style.top  = dotY + 'px';
  aimDot.style.transform = 'translate(-50%,-50%)';
  // Rotate the line
  aimLine.style.transform = 'rotate(' + aimAngle + 'deg)';
  aimAngleEl.textContent  = Math.round(aimAngle) + '\u00b0';
}

/**
 * padEventToAngle(e)
 * Converts a mouse/touch event on the aim pad to an angle in degrees.
 */
function padEventToAngle(e) {
  const rect = aimPad.getBoundingClientRect();
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;
  const dx = (e.clientX || (e.touches && e.touches[0].clientX)) - cx;
  const dy = (e.clientY || (e.touches && e.touches[0].clientY)) - cy;
  return Math.atan2(dy, dx) * 180 / Math.PI; // -180..180
}

aimPad.addEventListener('mousedown', function(e) {
  e.preventDefault();
  aimDragging = true;
  setAimAngle(padEventToAngle(e));
  aimPad.classList.add('shooting');
});

aimPad.addEventListener('click', function(e) {
  setAimAngle(padEventToAngle(e));
  // Fire immediately on click
  sendAction('shoot', null, aimAngle);
  aimPad.classList.add('shooting');
  setTimeout(function() { aimPad.classList.remove('shooting'); }, 150);
});

window.addEventListener('mousemove', function(e) {
  if (!aimDragging) return;
  setAimAngle(padEventToAngle(e));
});

window.addEventListener('mouseup', function() {
  aimDragging = false;
  aimPad.classList.remove('shooting');
});

// Touch support
aimPad.addEventListener('touchstart', function(e) {
  e.preventDefault();
  aimDragging = true;
  setAimAngle(padEventToAngle(e));
}, { passive: false });

aimPad.addEventListener('touchmove', function(e) {
  e.preventDefault();
  setAimAngle(padEventToAngle(e));
}, { passive: false });

aimPad.addEventListener('touchend', function() {
  aimDragging = false;
  sendAction('shoot', null, aimAngle);
});

// Initialise dot position
setAimAngle(0);

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════

registerBtn.addEventListener('click', doRegister);
document.getElementById('disconnect-btn').addEventListener('click', doDisconnect);
document.getElementById('clear-log').addEventListener('click', function() { actionLog.innerHTML = ''; });

[serverInput, usernameInput].forEach(function(el) {
  el.addEventListener('keydown', function(e) { if (e.key === 'Enter') doRegister(); });
});

async function doRegister() {
  const url  = (serverInput.value || DEFAULT_SERVER).replace(/\/$/, '');
  const name = usernameInput.value.trim();
  if (!name) { showSetupError('Enter a username'); return; }
  serverUrl = url;
  registerBtn.disabled    = true;
  registerBtn.textContent = 'Registering\u2026';
  hideSetupError();
  try {
    const res  = await apiFetch('/register', 'POST', { username: name });
    const data = await res.json();
    if (!res.ok) { showSetupError(data.error || 'Registration failed'); return; }
    playerId   = data.player_id;
    playerName = data.username;
    enterGame();
  } catch (e) {
    showSetupError('Cannot reach server: ' + (e.message || 'network error'));
  } finally {
    registerBtn.disabled    = false;
    registerBtn.textContent = 'Register & Connect';
  }
}

function enterGame() {
  linkBigscreen.href = serverUrl + '/bigscreen';
  linkMonitor.href   = serverUrl + '/monitor?player_id=' + encodeURIComponent(playerId);
  linkApi.href       = serverUrl + '/players';

  displayName.textContent = playerName;
  playerIdEl.textContent  = playerId;

  setupScreen.classList.remove('active');
  gameScreen.classList.add('active');

  startPoller();
  addLog('Registered as ' + playerName + ' (' + playerId + ')', 'ok');
  addLog('Server: ' + serverUrl, 'info');
  addLog('WASD=move  Space=shoot(aim)  Arrows=shoot cardinal  R=reload', 'info');
}

function doDisconnect() {
  stopPoller();
  stopContinuousMovement();
  heldMovementKeys.clear();
  lastMovementKey = null;
  playerId = null; playerName = '';
  gameScreen.classList.remove('active');
  setupScreen.classList.add('active');
}

// ══════════════════════════════════════════════════════════════════════════════
// STATE POLLER
// ══════════════════════════════════════════════════════════════════════════════

function startPoller() {
  stopPoller();
  pollTimer = setInterval(pollState, POLL_INTERVAL_MS);
  pollState();
}

function stopPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollState() {
  if (!playerId) return;
  try {
    const res = await apiFetch('/state?player_id=' + encodeURIComponent(playerId), 'GET');
    if (!res.ok) return;
    const data = await res.json();
    applyState(data);
  } catch (_) {}
}

function applyState(data) {
  if (!data.self) return;
  const s = data.self;
  localState.hp       = s.hp       != null ? s.hp       : localState.hp;
  localState.ammo     = s.ammo     != null ? s.ammo     : localState.ammo;
  localState.kills    = s.kills    != null ? s.kills    : localState.kills;
  localState.alive    = s.alive    != null ? s.alive    : localState.alive;
  localState.reloadCd = s.reloadCooldown > 0;
  localState.mode     = data.mode  || localState.mode;
  updateHUD();
}

// ══════════════════════════════════════════════════════════════════════════════
// HUD
// ══════════════════════════════════════════════════════════════════════════════

function updateHUD() {
  const { hp, ammo, kills, alive, reloadCd, mode } = localState;

  const hpPct = Math.max(0, Math.min(100, hp));
  barHp.style.width      = hpPct + '%';
  barHp.style.background = hpPct > 50 ? '#2ecc71' : hpPct > 25 ? '#f1c40f' : '#e74c3c';
  valHp.textContent      = hp;

  if (ammoPips.children.length !== MAX_AMMO) {
    ammoPips.innerHTML = '';
    for (var i = 0; i < MAX_AMMO; i++) {
      var pip = document.createElement('div');
      pip.className = 'pip';
      ammoPips.appendChild(pip);
    }
  }
  Array.from(ammoPips.children).forEach(function(pip, i) {
    pip.className = 'pip' + (i < ammo ? '' : ' empty');
  });
  valAmmo.textContent  = ammo + '/' + MAX_AMMO;
  valKills.textContent = kills;

  const modeMap = {
    test:     ['SANDBOX',  'badge-sandbox'],
    sandbox:  ['SANDBOX',  'badge-sandbox'],
    lobby:    ['LOBBY',    'badge-lobby'],
    battle:   ['BATTLE',   'badge-battle'],
    finished: ['FINISHED', 'badge-finished'],
  };
  const mEntry = modeMap[mode] || ['—', 'badge-sandbox'];
  modeBadge.textContent = mEntry[0];
  modeBadge.className   = 'badge ' + mEntry[1];

  indReload.classList.toggle('active', !!reloadCd);
  indDead.classList.toggle('hidden', !!alive);
  if (!alive) indDead.classList.add('dead');
}

// ══════════════════════════════════════════════════════════════════════════════
// KEYBOARD
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Key mapping.
 * Arrow keys fire a shoot in that cardinal direction (with a named direction).
 * Space fires a shoot at the current aim pad angle.
 * WASD fires movement.
 */
const KEY_MAP = {
  'w':          { action: 'move',   direction: 'up'    },
  'a':          { action: 'move',   direction: 'left'  },
  's':          { action: 'move',   direction: 'down'  },
  'd':          { action: 'move',   direction: 'right' },
  ' ':          { action: 'shoot',  direction: null,  useAimAngle: true  },
  'r':          { action: 'reload', direction: null   },
  // Arrow keys = cardinal shoot
  'ArrowUp':    { action: 'shoot',  direction: 'up'    },
  'ArrowLeft':  { action: 'shoot',  direction: 'left'  },
  'ArrowDown':  { action: 'shoot',  direction: 'down'  },
  'ArrowRight': { action: 'shoot',  direction: 'right' },
};

const heldKeys = new Set();

window.addEventListener('keydown', handleKeyDown);
window.addEventListener('keyup',   handleKeyUp);

function handleKeyDown(e) {
  if (!playerId) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  const keyId = e.key;
  if (heldKeys.has(keyId)) return;
  heldKeys.add(keyId);

  if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
  }

  const mapping = KEY_MAP[keyId];
  if (!mapping) return;

  flashKey(keyId);

  let action    = mapping.action;
  let direction = mapping.direction;
  let angle     = null;

  if (action === 'move') {
    lastMoveDir = direction;
    lastMovementKey = keyId;
    // Add to held movement keys for continuous movement
    heldMovementKeys.add(keyId);
    // Send immediate first move for responsiveness using the computed angle
    var moveAngle = getMovementAngle();
    if (moveAngle !== null) {
      sendAction('move', null, moveAngle);
    }
    // Start continuous movement if not already running
    if (!movementTimer) {
      startContinuousMovement();
    }
    return;
  }
  if (action === 'shoot' && mapping.useAimAngle) {
    // Space uses aim pad angle
    angle = aimAngle;
    direction = null;
  }

  sendAction(action, direction, angle);
}

function handleKeyUp(e) {
  heldKeys.delete(e.key);
  
  // Remove from held movement keys
  const keyId = e.key;
  if (['w', 'a', 's', 'd'].includes(keyId)) {
    heldMovementKeys.delete(keyId);
    // Update last movement key if this was the current one
    if (lastMovementKey === keyId) {
      // Pick another held key as the new last movement key
      lastMovementKey = heldMovementKeys.size > 0 ? Array.from(heldMovementKeys)[0] : null;
    }
    // Stop continuous movement if no movement keys are held
    if (heldMovementKeys.size === 0) {
      stopContinuousMovement();
    }
  }
}

// Calculate movement angle (degrees) from all currently held WASD keys.
// Returns null if no movement keys are held.
function getMovementAngle() {
  var dx = 0, dy = 0;
  if (heldMovementKeys.has('w')) dy -= 1;
  if (heldMovementKeys.has('s')) dy += 1;
  if (heldMovementKeys.has('a')) dx -= 1;
  if (heldMovementKeys.has('d')) dx += 1;
  if (dx === 0 && dy === 0) return null;
  return ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
}

// Continuous movement loop
function startContinuousMovement() {
  if (movementTimer) return; // Already running
  
  movementTimer = setInterval(function() {
    if (!playerId || !localState.alive || heldMovementKeys.size === 0) {
      stopContinuousMovement();
      return;
    }
    
    var angle = getMovementAngle();
    if (angle !== null) {
      sendAction('move', null, angle);
    }
  }, MOVEMENT_TICK_MS);
}

function stopContinuousMovement() {
  if (movementTimer) {
    clearInterval(movementTimer);
    movementTimer = null;
  }
}

// Key box flash
const KEY_BOX_MAP = {
  'w': KEY_BOXES.w, 'a': KEY_BOXES.a, 's': KEY_BOXES.s, 'd': KEY_BOXES.d,
  'ArrowUp': KEY_BOXES.up, 'ArrowLeft': KEY_BOXES.left,
  'ArrowDown': KEY_BOXES.down, 'ArrowRight': KEY_BOXES.right,
  ' ': KEY_BOXES.space,
  'r': KEY_BOXES.r,
};

function flashKey(keyId) {
  const el = KEY_BOX_MAP[keyId];
  if (!el) return;
  el.classList.add('pressed');
  setTimeout(function() { el.classList.remove('pressed'); }, 120);
}

// ══════════════════════════════════════════════════════════════════════════════
// ACTION SENDER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * sendAction(action, direction, angle)
 *
 * direction — cardinal string ('up'/'down'/'left'/'right') or null
 * angle     — degrees (0-359) or null
 *
 * If angle is provided it takes precedence over direction on the server.
 * Only one of direction or angle needs to be set; both can be sent.
 */
async function sendAction(action, direction, angle) {
  if (!playerId) return;
  angle = (typeof angle === 'number') ? angle : null;

  if (!localState.alive) {
    setLastAction('Dead — cannot act', 'warn');
    return;
  }
  if (action === 'shoot' && localState.ammo <= 0) {
    setLastAction('No ammo — press R to reload', 'warn');
    return;
  }
  if (action === 'reload' && localState.reloadCd) {
    scheduleRetry(action, direction, angle);
    setLastAction('Reload on cooldown — queued', 'warn');
    return;
  }

  const body = { player_id: playerId, action: action };
  if (direction)      body.direction = direction;
  if (angle !== null) body.angle     = angle;

  const dirStr = angle !== null ? ' \u2192 ' + Math.round(angle) + '\u00b0' :
                 direction       ? ' \u2192 ' + direction : '';
  setLastAction(action + dirStr + ' \u2026', 'info');

  try {
    const res  = await apiFetch('/action', 'POST', body);
    const data = await res.json();

    if (res.status === 429) {
      scheduleRetry(action, direction, angle);
      addLog('Rate limited — retrying', 'warn');
      return;
    }
    if (!res.ok) {
      const msg = data.error || 'Unknown error';
      setLastAction('\u2717 ' + action + dirStr + ': ' + msg, 'err');
      addLog('\u2717 ' + action + dirStr + ': ' + msg, 'err');
      if (msg.toLowerCase().includes('cooldown')) {
        scheduleRetry(action, direction, angle);
      }
      return;
    }

    if (data.state && data.state.self) applyState(data.state);
    setLastAction('\u2713 ' + action + dirStr, 'ok');
    addLog('\u2713 ' + action + dirStr, 'ok');

  } catch (e) {
    setLastAction('Network error', 'err');
  }
}

function scheduleRetry(action, direction, angle) {
  if (pendingRetry) return;
  pendingRetry = setTimeout(function() {
    pendingRetry = null;
    sendAction(action, direction, angle);
  }, ACTION_RETRY_MS);
}

// ══════════════════════════════════════════════════════════════════════════════
// API
// ══════════════════════════════════════════════════════════════════════════════

function apiFetch(path, method, body) {
  method = method || 'GET';
  const url  = serverUrl + path;
  const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(url, opts);
}

// ══════════════════════════════════════════════════════════════════════════════
// LOG / FEEDBACK
// ══════════════════════════════════════════════════════════════════════════════

function addLog(msg, type) {
  type = type || 'info';
  const entry = document.createElement('div');
  entry.className = 'log-entry log-' + type;
  const ts = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = '<span class="log-ts">' + ts + '</span>' + escapeHtml(msg);
  actionLog.prepend(entry);
  while (actionLog.children.length > MAX_LOG_ENTRIES) actionLog.removeChild(actionLog.lastChild);
}

function setLastAction(msg, type) {
  lastActionEl.textContent = msg;
  lastActionEl.className   = 'last-action ' + (type || 'ok');
}

function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.classList.remove('hidden');
}

function hideSetupError() {
  setupError.classList.add('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
