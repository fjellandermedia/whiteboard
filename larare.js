// Lärarens vy. Alla elever och läraren är anslutna till samma rum på
// reläservern, som sparar strecken och skickar dem vidare. Rumskoden och en
// hemlig nyckel sparas i lärarens webbläsare, så bara den som öppnade rummet
// kan se tavlorna.

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
  const background = new Board(); // lärarens uppgift, ritas under alla tavlor
  const tileScratch = document.createElement('canvas');
  const viewerScratch = document.createElement('canvas');
  const students = new Map(); // clientId -> student
  const order = []; // clientId i anslutningsordning
  let relay = null;
  let room = storage.get('wb-room') || '';
  let roomKey = storage.get('wb-room-key') || '';
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
    if (!roomKey || room !== storage.get('wb-room')) roomKey = randomId() + randomId();
    storage.set('wb-room', room);
    storage.set('wb-room-key', roomKey);
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
    openRelay();
  }

  function openRelay() {
    if (relay) relay.close();
    const base = relayBase();
    if (!base) {
      setStatus('Reläservern är inte inställd (config.js)', 'err');
      return;
    }
    setStatus('Ansluter…', 'warn');
    const url = base + '/room/' + room + '?role=teacher&key=' + encodeURIComponent(roomKey);
    diag.add('ansluter till ' + url.replace(/\?.*$/, ''));
    const r = new RelaySocket(url, {
      onOpen() {
        diag.add('ansluten, hämtar rummet');
      },
      onMessage(msg) {
        if (relay === r) handleMessage(msg);
      },
      onClose(code, reason) {
        if (relay !== r) return false;
        diag.add('anslutningen stängdes (' + code + (reason ? ' ' + reason : '') + ')');
        if (code === 4403) {
          // Koden används redan av någon annan lärare: välj en ny.
          setStatus('Rumskoden var upptagen, byter kod…', 'warn');
          storage.remove('wb-room');
          roomKey = '';
          setTimeout(() => startRoom(''), 500);
          return false;
        }
        setStatus('Tappade kontakten med servern, försöker igen…', 'warn');
        for (const s of students.values()) {
          s.connected = false;
          updateTile(s);
        }
        return true;
      },
    });
    relay = r;
    r.connect();
  }

  // ---------- Elever ----------
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : '';
    let student = clientId ? students.get(clientId) : null;
    switch (msg.t) {
      case 'ready':
        setStatus('Redo, väntar på elever', 'ok');
        return;
      case 'hello':
        if (!clientId) return;
        if (!student) student = createStudent(clientId);
        setName(student, msg.name);
        student.board.replace(Array.isArray(msg.strokes) ? msg.strokes : []);
        student.connected = msg.connected !== false;
        updateTile(student);
        markDirty(student);
        return;
      case 'join':
        if (!clientId) return;
        if (!student) student = createStudent(clientId);
        if (typeof msg.name === 'string' && msg.name) setName(student, msg.name);
        student.connected = true;
        updateTile(student);
        diag.add('elev ansluten: ' + (student.name || clientId));
        return;
      case 'leave':
        if (!student) return;
        student.connected = false;
        updateTile(student);
        return;
      case 'removed':
        if (student) dropStudent(student);
        return;
      case 'cleared':
        for (const s of students.values()) {
          s.board.clear();
          markDirty(s);
        }
        return;
      case 'background':
        background.replace(Array.isArray(msg.strokes) ? msg.strokes : []);
        for (const s of students.values()) markDirty(s);
        diag.add(background.isEmpty() ? 'uppgiften togs bort' : 'uppgift mottagen');
        return;
      case 'error':
        diag.add('servern svarade: ' + msg.code + ' ' + (msg.reason || ''));
        return;
      default:
        break;
    }
    if (!student) return;
    switch (msg.t) {
      case 'ss':
        student.board.start(msg.s);
        break;
      case 'sp':
        student.board.addPoints(msg.id, msg.p);
        break;
      case 'undo':
        if (!student.board.remove(msg.id)) student.board.undo();
        break;
      case 'clear':
        student.board.clear();
        break;
      default:
        return;
    }
    if (!student.connected) {
      student.connected = true;
      updateTile(student);
    }
    markDirty(student);
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
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Rensa';
    clear.title = 'Rensa den här elevens tavla';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Ta bort';
    remove.title = 'Ta bort tavlan från vyn';
    remove.hidden = true;
    meta.append(status, name, png, clear, remove);
    tile.append(canvas, meta);
    boardsEl.appendChild(tile);
    emptyEl.hidden = true;

    const student = {
      id: clientId,
      name: '',
      board: new Board(),
      connected: false,
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
    clear.addEventListener('click', () => clearStudent(student));
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
    if (viewing === student.id) renderViewerName();
    updateCount();
  }

  function updateCount() {
    const total = students.size;
    const online = [...students.values()].filter((s) => s.connected).length;
    countEl.textContent = total ? `${online} av ${total} elever anslutna` : '';
    countEl.className = 'status ' + (total && online === total ? 'ok' : total ? 'warn' : '');
    emptyEl.hidden = total > 0;
  }

  function clearStudent(student) {
    if (student.board.isEmpty()) return;
    if (!confirm('Rensa tavlan för ' + (student.name || 'eleven utan namn') + '? Den rensas även hos eleven.')) return;
    if (!relay || !relay.send({ t: 'clear-one', clientId: student.id })) {
      alert('Ingen kontakt med servern just nu. Försök igen om en stund.');
      return;
    }
    student.board.clear();
    markDirty(student);
  }

  function removeStudent(student) {
    if (relay) relay.send({ t: 'remove', clientId: student.id });
    dropStudent(student);
  }

  function dropStudent(student) {
    if (!students.has(student.id)) return;
    students.delete(student.id);
    order.splice(order.indexOf(student.id), 1);
    student.tile.remove();
    if (viewing === student.id) closeViewer();
    updateCount();
  }

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
      renderLayered(s.ctx, background, s.board, s.canvas.width, s.canvas.height, tileScratch);
      if (viewing === s.id) renderLayered(viewerCtx, background, s.board, viewerCanvas.width, viewerCanvas.height, viewerScratch);
    }
  }

  // ---------- Visningsläge ----------
  function viewerTitle(student) {
    return (student.name || 'Utan namn') + (student.connected ? '' : ' (frånkopplad)');
  }

  // Namnet är dolt när en tavla visas, så att den kan visas anonymt på projektorn.
  let nameShown = false;
  function renderViewerName() {
    const s = students.get(viewing);
    const el = $('viewerName');
    el.classList.toggle('shown', nameShown);
    el.textContent = nameShown && s ? viewerTitle(s) : 'Visa namn';
  }

  function openViewer(clientId) {
    const s = students.get(clientId);
    if (!s) return;
    viewing = clientId;
    nameShown = false;
    viewer.hidden = false;
    renderViewerName();
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
    if (s) renderLayered(viewerCtx, background, s.board, viewerCanvas.width, viewerCanvas.height, viewerScratch);
  }

  new ResizeObserver(resizeViewer).observe(viewerStage);
  $('close').addEventListener('click', closeViewer);
  $('viewerName').addEventListener('click', () => {
    nameShown = !nameShown;
    renderViewerName();
  });
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
    else if (e.key.toLowerCase() === 'n') {
      nameShown = !nameShown;
      renderViewerName();
    }
  });

  // ---------- Spara ----------
  function savePng(student) {
    exportCanvas(student.board, 1600, background).toBlob((blob) => {
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
        const canvas = exportCanvas(s.board, 1600, background);
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
  $('task').addEventListener('click', () => {
    window.open('uppgift.html#' + room, 'wb-task-' + room);
  });
  $('clearAll').addEventListener('click', () => {
    if (!students.size) return;
    if (!confirm('Rensa alla elevers tavlor? Uppgiften (bakgrunden) ligger kvar. Spara först om du vill behålla tavlorna.')) return;
    for (const s of students.values()) {
      s.board.clear();
      markDirty(s);
    }
    if (!relay || !relay.send({ t: 'clear' })) alert('Ingen kontakt med servern just nu. Försök igen om en stund.');
  });
  $('newRoom').addEventListener('click', () => {
    if (!confirm('Skapa ett nytt rum med ny kod? Alla elever kopplas bort och tavlorna försvinner från den här vyn.')) return;
    for (const s of [...students.values()]) dropStudent(s);
    storage.remove('wb-room');
    roomKey = '';
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
