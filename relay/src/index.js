// Reläserver för whiteboarden: en Cloudflare Worker med ett Durable Object per rum.
// Eleverna skickar sina streck hit över WebSocket, servern sparar dem och skickar
// vidare till läraren. Läraren får hela rummet när hen ansluter, så en omladdning
// tappar ingenting. Servern tittar aldrig på innehållet utöver att hålla ordning
// på vilka streck som hör till vilken elev.

const MAX_NAME = 40;
const MAX_STROKE_JSON = 900_000; // tecken per elev, hålls under lagringsgränsen
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // rum rensas efter en veckas tystnad
const SAVE_DELAY_MS = 10000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/room\/([A-Z0-9]{2,12})$/.exec(url.pathname);
    if (!m) {
      return new Response(JSON.stringify({ name: 'whiteboard-relay', ok: true }), {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    const id = env.ROOMS.idFromName(m[1]);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.students = null; // clientId -> { name, strokes }
    this.background = []; // lärarens uppgift
    this.dirty = new Set();
    this.backgroundDirty = false;
    this.saveTimer = null;
  }

  async load() {
    if (this.students) return;
    this.students = new Map();
    const stored = await this.state.storage.list({ prefix: 's:' });
    for (const [key, value] of stored) this.students.set(key.slice(2), value);
    this.background = (await this.state.storage.get('bg')) || [];
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    await this.load();

    const refuse = (code, reason) => {
      server.accept();
      server.send(JSON.stringify({ t: 'error', code, reason }));
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    const teacherKey = await this.state.storage.get('teacherKey');

    if (role === 'teacher') {
      const key = String(url.searchParams.get('key') || '').slice(0, 64);
      if (!key) return refuse(4400, 'key missing');
      if (teacherKey && teacherKey !== key) return refuse(4403, 'wrong key');
      if (!teacherKey) await this.state.storage.put('teacherKey', key);
      await this.touch();
      this.state.acceptWebSocket(server, ['teacher']);
      server.serializeAttachment({ role: 'teacher' });
      server.send(JSON.stringify({ t: 'background', strokes: this.background }));
      for (const [clientId, s] of this.students) {
        server.send(JSON.stringify({ t: 'hello', clientId, name: s.name, strokes: s.strokes, connected: this.isConnected(clientId) }));
      }
      server.send(JSON.stringify({ t: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === 'task') {
      // Lärarens uppgiftssida: samma nyckel som lärarvyn.
      const key = String(url.searchParams.get('key') || '').slice(0, 64);
      if (!key || !teacherKey || teacherKey !== key) return refuse(4403, 'wrong key');
      this.state.acceptWebSocket(server, ['task']);
      server.serializeAttachment({ role: 'task' });
      server.send(JSON.stringify({ t: 'background', strokes: this.background }));
      server.send(JSON.stringify({ t: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (role === 'student') {
      const clientId = String(url.searchParams.get('client') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      const name = String(url.searchParams.get('name') || '').slice(0, MAX_NAME);
      if (!clientId) return refuse(4400, 'client missing');
      if (!teacherKey) return refuse(4404, 'no room');
      // En ny flik eller omladdning ersätter en tidigare anslutning från samma elev.
      for (const old of this.state.getWebSockets(clientId)) {
        try { old.close(4000, 'replaced'); } catch (e) { /* ignorera */ }
      }
      await this.touch();
      let student = this.students.get(clientId);
      if (!student) {
        student = { name, strokes: [] };
        this.students.set(clientId, student);
      } else if (name) {
        student.name = name;
      }
      this.markDirty(clientId);
      this.state.acceptWebSocket(server, ['student', clientId]);
      server.serializeAttachment({ role: 'student', clientId });
      this.toTeachers({ t: 'join', clientId, name: student.name });
      server.send(JSON.stringify({ t: 'background', strokes: this.background }));
      server.send(JSON.stringify({ t: 'ready' }));
      return new Response(null, { status: 101, webSocket: client });
    }

    return refuse(4400, 'unknown role');
  }

  async webSocketMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    await this.load();
    const att = ws.deserializeAttachment() || {};
    if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    if (att.role === 'student') return this.fromStudent(att.clientId, msg);
    if (att.role === 'teacher') return this.fromTeacher(msg);
    if (att.role === 'task') return this.fromTask(msg);
  }

  async webSocketClose(ws) {
    await this.load();
    const att = ws.deserializeAttachment() || {};
    // Den anslutning som stängs kan fortfarande finnas med i listan, så räkna bort den.
    if (att.role === 'student' && !this.isConnected(att.clientId, ws)) {
      this.toTeachers({ t: 'leave', clientId: att.clientId });
    }
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  async alarm() {
    // Rummet har varit tyst länge: rensa allt så koden kan återanvändas.
    await this.state.storage.deleteAll();
    this.students = new Map();
  }

  // ---------- Meddelanden ----------

  fromStudent(clientId, msg) {
    const student = this.students.get(clientId);
    if (!student) return;
    switch (msg.t) {
      case 'hello':
        if (typeof msg.name === 'string') student.name = msg.name.slice(0, MAX_NAME);
        student.strokes = Array.isArray(msg.strokes) ? msg.strokes.filter(validStroke) : [];
        this.toTeachers({ t: 'hello', clientId, name: student.name, strokes: student.strokes, connected: true });
        break;
      case 'ss':
        if (!validStroke(msg.s)) return;
        replaceOrPush(student.strokes, msg.s);
        this.toTeachers({ t: 'ss', clientId, s: msg.s });
        break;
      case 'sp': {
        const stroke = student.strokes.find((s) => s.id === msg.id);
        if (!stroke || !Array.isArray(msg.p)) return;
        for (const p of msg.p) if (validPoint(p)) stroke.points.push(p);
        this.toTeachers({ t: 'sp', clientId, id: msg.id, p: msg.p });
        break;
      }
      case 'se':
        break;
      case 'undo': {
        const i = student.strokes.findIndex((s) => s.id === msg.id);
        if (i >= 0) student.strokes.splice(i, 1);
        else student.strokes.pop();
        this.toTeachers({ t: 'undo', clientId, id: msg.id });
        break;
      }
      case 'clear':
        student.strokes = [];
        this.toTeachers({ t: 'clear', clientId });
        break;
      default:
        return;
    }
    this.markDirty(clientId);
  }

  fromTeacher(msg) {
    switch (msg.t) {
      case 'clear':
        for (const [clientId, s] of this.students) {
          s.strokes = [];
          this.markDirty(clientId);
        }
        this.toStudents({ t: 'clear' });
        this.toTeachers({ t: 'cleared' });
        break;
      case 'clear-one': {
        const clientId = String(msg.clientId || '');
        const student = this.students.get(clientId);
        if (!student) return;
        student.strokes = [];
        this.markDirty(clientId);
        this.toStudent(clientId, { t: 'clear' });
        this.toTeachers({ t: 'clear', clientId });
        break;
      }
      case 'remove-all': {
        // Alla elever kopplas bort och deras tavlor raderas. Uppgiften ligger kvar.
        const keys = [];
        for (const clientId of this.students.keys()) {
          for (const ws of this.state.getWebSockets(clientId)) {
            try { ws.close(4001, 'removed'); } catch (e) { /* ignorera */ }
          }
          keys.push('s:' + clientId);
        }
        this.students.clear();
        this.dirty.clear();
        if (keys.length) this.state.storage.delete(keys);
        this.toTeachers({ t: 'removed-all' });
        break;
      }
      case 'remove': {
        const clientId = String(msg.clientId || '');
        if (!this.students.has(clientId)) return;
        for (const ws of this.state.getWebSockets(clientId)) {
          try { ws.close(4001, 'removed'); } catch (e) { /* ignorera */ }
        }
        this.students.delete(clientId);
        this.state.storage.delete('s:' + clientId);
        this.toTeachers({ t: 'removed', clientId });
        break;
      }
      default:
        return;
    }
  }

  fromTask(msg) {
    if (msg.t !== 'background') return;
    this.background = Array.isArray(msg.strokes) ? msg.strokes.filter(validStroke) : [];
    trimStrokes({ strokes: this.background });
    this.backgroundDirty = true;
    this.markDirty(null);
    const out = { t: 'background', strokes: this.background };
    this.toStudents(out);
    this.toTeachers(out);
    this.toTasks(out);
  }

  // ---------- Hjälpfunktioner ----------

  isConnected(clientId, except) {
    return this.state.getWebSockets(clientId).some((ws) => ws !== except);
  }

  toTeachers(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets('teacher')) {
      try { ws.send(text); } catch (e) { /* stängd */ }
    }
  }

  toStudent(clientId, msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets(clientId)) {
      try { ws.send(text); } catch (e) { /* stängd */ }
    }
  }

  toTasks(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets('task')) {
      try { ws.send(text); } catch (e) { /* stängd */ }
    }
  }

  toStudents(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets('student')) {
      try { ws.send(text); } catch (e) { /* stängd */ }
    }
  }

  async touch() {
    await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  markDirty(clientId) {
    if (clientId) this.dirty.add(clientId);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  save() {
    const entries = {};
    for (const clientId of this.dirty) {
      const s = this.students.get(clientId);
      if (!s) continue;
      trimStrokes(s);
      entries['s:' + clientId] = s;
    }
    this.dirty.clear();
    if (this.backgroundDirty) {
      entries.bg = this.background;
      this.backgroundDirty = false;
    }
    if (Object.keys(entries).length) this.state.storage.put(entries);
  }
}

function validPoint(p) {
  return Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function validStroke(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string') return false;
  if (s.tool === 'text') return typeof s.text === 'string';
  return Array.isArray(s.points);
}

function replaceOrPush(strokes, stroke) {
  const i = strokes.findIndex((s) => s.id === stroke.id);
  if (i >= 0) strokes[i] = stroke;
  else strokes.push(stroke);
}

// Håller en elevs sparade streck under lagringsgränsen genom att släppa de äldsta.
function trimStrokes(student) {
  while (student.strokes.length > 1 && JSON.stringify(student.strokes).length > MAX_STROKE_JSON) {
    student.strokes.splice(0, Math.max(1, Math.floor(student.strokes.length / 10)));
  }
}
