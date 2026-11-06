// Lärarens vy. Den här datorn är "servern": varje elev kopplar upp sig direkt
// mot lärarens webbläsare via WebRTC (PeerJS). PeerJS:s publika server används
// bara för att hitta varandra, inga ritningar passerar den.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const countEl = $('count');
  const boardsEl = $('boards');
  const emptyEl = $('empty');
  const viewer = $('viewer');
  const viewerCanvas = $('viewerCanvas');
  const viewerCtx = viewerCanvas.getContext('2d');
  const viewerStage = $('viewerStage');

  const TILE_W = 640;
  const TILE_H = TILE_W / BOARD_ASPECT;

  const diag = makeDiag($('diag'));
  diag.add('webbläsare: ' + navigator.userAgent);
  const students = new Map(); // clientId -> student
  const order = []; // clientId i anslutningsordning
  let peer = null;
  let room = storage.get('wb-room') || '';
  let viewing = null; // clientId som visas i visningsläget
  let needsFrame = false;

  // ---------- Inställningar ----------
  const compactBox = $('compact');
  compactBox.checked = storage.get('wb-compact') === '1';
  compactBox.addEventListener('change', () => {
    storage.set('wb-compact', compactBox.checked ? '1' : '0');
    $('invite').classList.toggle('compact', compactBox.checked);
  });
  $('invite').classList.toggle('compact', compactBox.checked);

  const tileSize = $('tileSize');
  tileSize.value = storage.get('wb-tile') || '260';
  const applyTile = () => boardsEl.style.setProperty('--tile', tileSize.value + 'px');
  tileSize.addEventListener('input', () => {
    storage.set('wb-tile', tileSize.value);
    applyTile();
  });
  applyTile();

  // ---------- Rum och anslutning ----------
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status ' + cls;
    diag.add('status: ' + text);
  }

  function startRoom(code) {
    room = normalizeRoomCode(code) || makeRoomCode();
    storage.set('wb-room', room);
    $('code').textContent = room;
    const url = new URL('elev.html', location.href);
    url.hash = room;
    $('link').textContent = url.href.replace(/^https?:\/\//, '');
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url.href);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch (e) {
      $('qr').hidden = true;
    }
    document.title = 'Whiteboard ' + room + ': Lärare';
    openPeer();
  }

  let retryTimer = 0;
  function openPeer() {
    if (peer) {
      peer.destroy();
      peer = null;
    }
    setStatus('Ansluter…', 'warn');
    const p = new Peer(roomPeerId(room), peerOptions());
    peer = p;
    p.on('open', (id) => {
      if (peer !== p) return;
      diag.add('signaleringsserver ok, rum ' + id);
      setStatus('Redo, väntar på elever', 'ok');
      // Be redan anslutna elever skicka om sina tavlor efter en omstart.
      for (const s of students.values()) sendTo(s, { t: 'resend' });
    });
    p.on('connection', (conn) => {
      if (peer !== p) return;
      attach(conn);
    });
    p.on('disconnected', () => {
      if (peer !== p) return;
      setStatus('Tappade kontakten med servern, försöker igen…', 'warn');
      scheduleRetry(() => {
        if (peer === p && !p.destroyed) p.reconnect();
      });
    });
    p.on('error', (err) => {
      if (peer !== p) return;
      diag.add('fel: ' + err.type + ' ' + (err.message || ''));
      if (err.type === 'unavailable-id') {
        // Koden används redan av någon annan: välj en ny.
        setStatus('Rumskoden var upptagen, byter kod…', 'warn');
        storage.remove('wb-room');
        setTimeout(() => startRoom(''), 500);
        return;
      }
      if (err.type === 'peer-unavailable') return;
      setStatus('Ingen kontakt med servern, försöker igen…', 'err');
      scheduleRetry(() => openPeer());
    });
  }

  function scheduleRetry(fn) {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      fn();
    }, 3000);
  }

  // ---------- Elever ----------
  function attach(conn) {
    const meta = conn.metadata || {};
    let student = null;
    const label = (meta.name || 'okänd') + ' (' + String(meta.clientId || conn.peer).slice(-6) + ')';
    diag.add('förfrågan från ' + label);
    watchPeerConnection(conn.peerConnection, diag, label);
    conn.on('open', () => diag.add(label + ': datakanal öppen'));

    function bind(clientId, name) {
      clientId = String(clientId || '').slice(0, 64) || 'okänd-' + randomId();
      student = students.get(clientId);
      if (!student) {
        student = createStudent(clientId);
      }
      if (student.conn && student.conn !== conn) {
        try { student.conn.close(); } catch (e) { /* ignorera */ }
      }
      student.conn = conn;
      student.connected = true;
      student.lastSeen = Date.now();
      if (typeof name === 'string') setName(student, name);
      updateTile(student);
    }

    if (meta.clientId) bind(meta.clientId, meta.name);

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') {
        bind(msg.clientId || meta.clientId, msg.name);
        student.board.replace(Array.isArray(msg.strokes) ? msg.strokes : []);
        markDirty(student);
        return;
      }
      if (!student) return;
      student.lastSeen = Date.now();
      if (!student.connected && student.conn === conn) {
        student.connected = true;
        updateTile(student);
      }
      switch (msg.t) {
        case 'ss':
          student.board.start(msg.s);
          break;
        case 'sp':
          student.board.addPoints(msg.id, msg.p);
          break;
        case 'se':
        case 'ping':
          return;
        case 'bye':
          student.connected = false;
          student.conn = null;
          updateTile(student);
          try { conn.close(); } catch (e) { /* ignorera */ }
          return;
        case 'undo':
          if (!student.board.remove(msg.id)) student.board.undo();
          break;
        case 'clear':
          student.board.clear();
          break;
        default:
          return;
      }
      markDirty(student);
    });
    conn.on('close', () => {
      if (student && student.conn === conn) {
        student.connected = false;
        student.conn = null;
        updateTile(student);
      }
    });
    conn.on('error', () => {
      if (student && student.conn === conn) {
        student.connected = false;
        updateTile(student);
      }
    });
  }

  function createStudent(clientId) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    const canvas = document.createElement('canvas');
    canvas.width = TILE_W;
    canvas.height = TILE_H;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const status = document.createElement('span');
    status.className = 'status';
    status.title = 'Ansluten';
    const name = document.createElement('span');
    name.className = 'name';
    const png = document.createElement('button');
    png.type = 'button';
    png.textContent = 'png';
    png.title = 'Spara tavlan som png';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Ta bort';
    remove.title = 'Ta bort tavlan från vyn';
    remove.hidden = true;
    meta.append(status, name, png, remove);
    tile.append(canvas, meta);
    boardsEl.appendChild(tile);
    emptyEl.hidden = true;

    const student = {
      id: clientId,
      name: '',
      board: new Board(),
      conn: null,
      connected: false,
      lastSeen: 0,
      dirty: true,
      tile,
      canvas,
      ctx: canvas.getContext('2d'),
      nameEl: name,
      statusEl: status,
      removeEl: remove,
    };
    tile.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openViewer(clientId);
    });
    png.addEventListener('click', () => savePng(student));
    remove.addEventListener('click', () => removeStudent(student));
    students.set(clientId, student);
    order.push(clientId);
    updateCount();
    markDirty(student);
    return student;
  }

  function setName(student, name) {
    student.name = String(name || '').trim().slice(0, 40);
    student.nameEl.textContent = student.name || 'Utan namn';
  }

  function updateTile(student) {
    student.tile.classList.toggle('offline', !student.connected);
    student.statusEl.className = 'status ' + (student.connected ? 'ok' : 'err');
    student.statusEl.title = student.connected ? 'Ansluten' : 'Frånkopplad';
    student.removeEl.hidden = student.connected;
    if (viewing === student.id) $('viewerName').textContent = viewerTitle(student);
    updateCount();
  }

  function updateCount() {
    const total = students.size;
    const online = [...students.values()].filter((s) => s.connected).length;
    countEl.textContent = total ? `${online} av ${total} elever anslutna` : '';
    countEl.className = 'status ' + (total && online === total ? 'ok' : total ? 'warn' : '');
    emptyEl.hidden = total > 0;
  }

  function removeStudent(student) {
    if (student.conn) {
      try { student.conn.close(); } catch (e) { /* ignorera */ }
    }
    students.delete(student.id);
    order.splice(order.indexOf(student.id), 1);
    student.tile.remove();
    if (viewing === student.id) closeViewer();
    updateCount();
  }

  function sendTo(student, msg) {
    if (student.conn && student.conn.open) {
      try { student.conn.send(msg); } catch (e) { /* ignorera */ }
    }
  }

  // Elever som inte hörts av på ett tag markeras som frånkopplade.
  setInterval(() => {
    const now = Date.now();
    for (const s of students.values()) {
      if (s.connected && now - s.lastSeen > 12000) {
        s.connected = false;
        updateTile(s);
      }
    }
  }, 3000);

  // ---------- Rendering ----------
  function markDirty(student) {
    student.dirty = true;
    if (!needsFrame) {
      needsFrame = true;
      requestAnimationFrame(frame);
    }
  }

  function frame() {
    needsFrame = false;
    for (const s of students.values()) {
      if (!s.dirty) continue;
      s.dirty = false;
      renderBoard(s.ctx, s.board, s.canvas.width, s.canvas.height);
      if (viewing === s.id) renderBoard(viewerCtx, s.board, viewerCanvas.width, viewerCanvas.height);
    }
  }

  // ---------- Visningsläge ----------
  function viewerTitle(student) {
    return (student.name || 'Utan namn') + (student.connected ? '' : ' (frånkopplad)');
  }

  function openViewer(clientId) {
    const s = students.get(clientId);
    if (!s) return;
    viewing = clientId;
    viewer.hidden = false;
    $('viewerName').textContent = viewerTitle(s);
    resizeViewer();
  }

  function closeViewer() {
    viewing = null;
    viewer.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function stepViewer(delta) {
    if (!viewing || !order.length) return;
    const i = order.indexOf(viewing);
    const next = order[(i + delta + order.length) % order.length];
    openViewer(next);
  }

  function resizeViewer() {
    if (!viewing) return;
    fitCanvas(viewerCanvas, viewerStage);
    const s = students.get(viewing);
    if (s) renderBoard(viewerCtx, s.board, viewerCanvas.width, viewerCanvas.height);
  }

  new ResizeObserver(resizeViewer).observe(viewerStage);
  $('close').addEventListener('click', closeViewer);
  $('prev').addEventListener('click', () => stepViewer(-1));
  $('next').addEventListener('click', () => stepViewer(1));
  $('fullscreen').addEventListener('click', toggleFullscreen);
  $('viewerPng').addEventListener('click', () => {
    const s = students.get(viewing);
    if (s) savePng(s);
  });
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (viewer.requestFullscreen) viewer.requestFullscreen().catch(() => {});
  }
  document.addEventListener('keydown', (e) => {
    if (viewer.hidden) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') stepViewer(-1);
    else if (e.key === 'ArrowRight') stepViewer(1);
    else if (e.key.toLowerCase() === 'f') toggleFullscreen();
  });

  // ---------- Spara ----------
  function savePng(student) {
    exportCanvas(student.board, 1600).toBlob((blob) => {
      if (blob) downloadBlob(blob, safeFileName(student.name) + '.png');
    }, 'image/png');
  }

  async function saveAllPdf() {
    const list = order.map((id) => students.get(id)).filter(Boolean);
    if (!list.length) {
      alert('Det finns inga tavlor att spara.');
      return;
    }
    const button = $('savePdf');
    button.disabled = true;
    try {
      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pageW = 841.89; // A4 liggande
      const pageH = 595.28;
      const margin = 28;
      const titleH = 22;
      for (const s of list) {
        const canvas = exportCanvas(s.board, 1600);
        const bytes = await new Promise((resolve) => canvas.toBlob((b) => b.arrayBuffer().then(resolve), 'image/png'));
        const img = await doc.embedPng(bytes);
        const page = doc.addPage([pageW, pageH]);
        const availW = pageW - margin * 2;
        const availH = pageH - margin * 2 - titleH;
        const scale = Math.min(availW / img.width, availH / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const title = (s.name || 'Utan namn').replace(/[^ -~ -ÿ]/g, '');
        page.drawText(title, { x: margin, y: pageH - margin - 14, size: 14, font, color: rgb(0.11, 0.11, 0.11) });
        page.drawImage(img, { x: margin + (availW - w) / 2, y: margin, width: w, height: h });
        page.drawRectangle({
          x: margin + (availW - w) / 2,
          y: margin,
          width: w,
          height: h,
          borderColor: rgb(0.8, 0.8, 0.8),
          borderWidth: 0.5,
        });
      }
      const pdf = await doc.save();
      downloadBlob(new Blob([pdf], { type: 'application/pdf' }), `tavlor-${room}-${timestamp()}.pdf`);
    } catch (e) {
      console.error(e);
      alert('Det gick inte att skapa pdf-filen: ' + (e && e.message ? e.message : e));
    } finally {
      button.disabled = false;
    }
  }

  // ---------- Knappar ----------
  $('savePdf').addEventListener('click', saveAllPdf);
  $('clearAll').addEventListener('click', () => {
    if (!students.size) return;
    if (!confirm('Rensa alla elevers tavlor och börja på en ny uppgift? Spara först om du vill behålla dem.')) return;
    for (const s of students.values()) {
      s.board.clear();
      sendTo(s, { t: 'clear' });
      markDirty(s);
    }
  });
  $('newRoom').addEventListener('click', () => {
    if (!confirm('Skapa ett nytt rum med ny kod? Alla elever kopplas bort och tavlorna försvinner från den här vyn.')) return;
    for (const s of [...students.values()]) removeStudent(s);
    storage.remove('wb-room');
    startRoom('');
  });

  window.addEventListener('beforeunload', (e) => {
    if ([...students.values()].some((s) => !s.board.isEmpty())) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  startRoom(room);
})();
