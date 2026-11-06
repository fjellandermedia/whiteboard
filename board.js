// Delad modell och renderare för whiteboard-tavlor.
// Koordinater sparas normaliserade: x och y i intervallet 0–1 relativt en tavla
// med bildförhållandet 16:10. Streckbredd sparas relativt tavlans bredd.
// Varje punkt är [x, y, tryck].

const BOARD_ASPECT = 16 / 10;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const PEN_COLORS = [
  { id: 'black', name: 'Svart', value: '#1d1d1b' },
  { id: 'blue', name: 'Blå', value: '#1f5f8b' },
  { id: 'red', name: 'Röd', value: '#b3261e' },
  { id: 'green', name: 'Grön', value: '#2d7a3e' },
  { id: 'orange', name: 'Orange', value: '#d9771e' },
];
const PEN_WIDTHS = [
  { id: 'thin', name: 'Tunn', value: 0.0018 },
  { id: 'medium', name: 'Mellan', value: 0.0032 },
  { id: 'thick', name: 'Tjock', value: 0.006 },
];
const ERASER_WIDTH = 0.025;

function makeRoomCode(length = 5) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
}

function normalizeRoomCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

class Board {
  constructor() {
    this.strokes = [];
    this.byId = new Map();
  }
  replace(strokes) {
    this.strokes = [];
    this.byId.clear();
    for (const s of strokes || []) this.start(s);
  }
  start(stroke) {
    if (!stroke || !stroke.id || !Array.isArray(stroke.points)) return;
    const copy = {
      id: String(stroke.id),
      tool: stroke.tool === 'eraser' ? 'eraser' : 'pen',
      color: typeof stroke.color === 'string' ? stroke.color : '#1d1d1b',
      width: Number(stroke.width) || PEN_WIDTHS[1].value,
      points: stroke.points.map(clampPoint).filter(Boolean),
    };
    if (this.byId.has(copy.id)) {
      const old = this.byId.get(copy.id);
      this.strokes[this.strokes.indexOf(old)] = copy;
    } else {
      this.strokes.push(copy);
    }
    this.byId.set(copy.id, copy);
    return copy;
  }
  addPoints(id, points) {
    const s = this.byId.get(String(id));
    if (!s || !Array.isArray(points)) return null;
    for (const p of points) {
      const c = clampPoint(p);
      if (c) s.points.push(c);
    }
    return s;
  }
  remove(id) {
    const s = this.byId.get(String(id));
    if (!s) return false;
    this.byId.delete(s.id);
    this.strokes.splice(this.strokes.indexOf(s), 1);
    return true;
  }
  undo() {
    const s = this.strokes.pop();
    if (!s) return null;
    this.byId.delete(s.id);
    return s;
  }
  clear() {
    this.strokes = [];
    this.byId.clear();
  }
  isEmpty() {
    return this.strokes.length === 0;
  }
  toJSON() {
    return this.strokes;
  }
}

function clampPoint(p) {
  if (!Array.isArray(p) || p.length < 2) return null;
  const x = Number(p[0]);
  const y = Number(p[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let pr = Number(p[2]);
  if (!Number.isFinite(pr) || pr <= 0) pr = 0.5;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), Math.min(1, pr)];
}

function widthFactor(pressure, tool) {
  if (tool === 'eraser') return 1;
  return 0.5 + pressure;
}

// Ritar ett streck på en canvas med måtten w × h (i pixlar).
// `from` anger från vilket punktindex ritningen ska fortsätta, så att ett
// pågående streck kan ritas inkrementellt.
function drawStroke(ctx, s, w, h, from = 0) {
  const pts = s.points;
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
  } else {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
  }
  const base = s.width * w;
  if (pts.length === 1) {
    const p = pts[0];
    ctx.beginPath();
    ctx.arc(p[0] * w, p[1] * h, (base * widthFactor(p[2], s.tool)) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  for (let i = Math.max(1, from); i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    ctx.lineWidth = Math.max(0.5, base * widthFactor((a[2] + b[2]) / 2, s.tool));
    ctx.beginPath();
    ctx.moveTo(a[0] * w, a[1] * h);
    ctx.lineTo(b[0] * w, b[1] * h);
    ctx.stroke();
  }
  ctx.restore();
}

function renderBoard(ctx, board, w, h) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
  for (const s of board.strokes) drawStroke(ctx, s, w, h);
}

// Ritar lärarens uppgift (bakgrund) och elevens streck ovanpå. Elevens streck
// ritas på ett eget lager så att suddet inte tar bort bakgrunden. `scratch` är
// en canvas som återanvänds som lager.
function renderLayered(ctx, background, board, w, h, scratch) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
  if (background && !background.isEmpty()) {
    for (const s of background.strokes) drawStroke(ctx, s, w, h);
  }
  if (!board || board.isEmpty()) return;
  if (!scratch) {
    for (const s of board.strokes) drawStroke(ctx, s, w, h);
    return;
  }
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  renderBoard(scratch.getContext('2d'), board, w, h);
  ctx.drawImage(scratch, 0, 0);
}

// Renderar tavlan till en ny canvas med vit bakgrund, för export.
function exportCanvas(board, width = 1600, background = null) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(width / BOARD_ASPECT);
  const ctx = canvas.getContext('2d');
  const layer = document.createElement('canvas');
  layer.width = canvas.width;
  layer.height = canvas.height;
  renderLayered(layer.getContext('2d'), background, board, layer.width, layer.height, document.createElement('canvas'));
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(layer, 0, 0);
  return canvas;
}

// Anpassar en canvas till sitt omslutande element med bildförhållandet 16:10
// och tar hänsyn till skärmens pixeltäthet. Returnerar true om storleken ändrades.
function fitCanvas(canvas, container) {
  const rect = container.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  let cssW = rect.width;
  let cssH = cssW / BOARD_ASPECT;
  if (cssH > rect.height) {
    cssH = rect.height;
    cssW = cssH * BOARD_ASPECT;
  }
  cssW = Math.max(1, Math.floor(cssW));
  cssH = Math.max(1, Math.floor(cssH));
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
    return true;
  }
  return false;
}

function safeFileName(text, fallback = 'tavla') {
  const cleaned = String(text || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return cleaned || fallback;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// Säker åtkomst till webbläsarens lagring. I vissa lägen (privat surfning i
// äldre Safari, blockerade cookies) kastar localStorage fel, och då ska sidan
// ändå fungera, bara utan att komma ihåg något.
const storage = {
  get(key, session) {
    try {
      return (session ? sessionStorage : localStorage).getItem(key);
    } catch (e) {
      return null;
    }
  },
  set(key, value, session) {
    try {
      (session ? sessionStorage : localStorage).setItem(key, value);
    } catch (e) {
      /* ignorera */
    }
  },
  remove(key, session) {
    try {
      (session ? sessionStorage : localStorage).removeItem(key);
    } catch (e) {
      /* ignorera */
    }
  },
  keys() {
    try {
      return Object.keys(localStorage);
    } catch (e) {
      return [];
    }
  },
};

// Diagnostik: en kort logg som visas för användaren vid problem.
function makeDiag(el) {
  const lines = [];
  const render = () => {
    if (el) el.textContent = lines.join('\n');
  };
  const stamp = () => new Date().toTimeString().slice(0, 8);
  return {
    add(text) {
      lines.push(stamp() + ' ' + text);
      if (lines.length > 60) lines.shift();
      render();
    },
  };
}

// Adressen till reläservern. Sätts i config.js efter att reläet publicerats.
function relayBase() {
  const base = String(window.WB_RELAY_URL || '').trim().replace(/\/+$/, '');
  if (!/^(https?|wss?):\/\/[^/]+$/.test(base) || /DITT-KONTO/.test(base)) return null;
  return base.replace(/^http/, 'ws');
}

// WebSocket mot reläservern med automatisk återanslutning.
// handlers: { onOpen(), onMessage(msg), onClose(code, reason), onStatus(text) }
class RelaySocket {
  constructor(url, handlers) {
    this.url = url;
    this.handlers = handlers || {};
    this.ws = null;
    this.timer = 0;
    this.delay = 1000;
    this.stopped = false;
    this.pingTimer = 0;
  }
  connect() {
    if (this.stopped) return;
    this.clearTimer();
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch (e) { /* ignorera */ }
    }
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.emit('onStatus', 'Ogiltig reläadress');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.delay = 1000;
      this.emit('onOpen');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ t: 'ping' }), 20000);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg && msg.t === 'pong') return;
      this.emit('onMessage', msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      const permanent = this.emit('onClose', e.code, e.reason) === false;
      if (!permanent) this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose följer alltid */ };
  }
  scheduleReconnect(delay) {
    if (this.stopped) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.connect();
    }, delay || this.delay);
    this.delay = Math.min(15000, this.delay * 1.6);
  }
  clearTimer() {
    clearTimeout(this.timer);
    this.timer = 0;
  }
  get open() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
  send(msg) {
    if (!this.open) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }
  close() {
    this.stopped = true;
    this.clearTimer();
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch (e) { /* ignorera */ }
      this.ws = null;
    }
  }
  emit(name, ...args) {
    const fn = this.handlers[name];
    return fn ? fn(...args) : undefined;
  }
}
