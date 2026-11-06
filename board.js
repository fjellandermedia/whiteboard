// Delad modell och renderare för whiteboard-tavlor.
// Koordinater sparas normaliserade: x och y i intervallet 0–1 relativt en tavla
// med bildförhållandet 16:10. Streckbredd sparas relativt tavlans bredd.
// Varje punkt är [x, y, tryck].

const BOARD_ASPECT = 16 / 10;
const ROOM_PREFIX = 'pdffix-tavla-';
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

function roomPeerId(code) {
  return ROOM_PREFIX + normalizeRoomCode(code);
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

// Renderar tavlan till en ny canvas med vit bakgrund, för export.
function exportCanvas(board, width = 1600) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(width / BOARD_ASPECT);
  const ctx = canvas.getContext('2d');
  const layer = document.createElement('canvas');
  layer.width = canvas.width;
  layer.height = canvas.height;
  renderBoard(layer.getContext('2d'), board, layer.width, layer.height);
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

// Inställningar för PeerJS. Som standard används PeerJS:s publika server bara
// för att hitta varandra. Vill du köra en egen PeerServer, lägg t.ex. in
// <script>window.WB_PEER_OPTIONS = { host: 'server.exempel.se', port: 443, path: '/' };</script>
// före board.js på båda sidorna.
function peerOptions() {
  return Object.assign({ debug: 1 }, window.WB_PEER_OPTIONS || {});
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
