// Elevens whiteboard. Strecken lagras lokalt i webbläsaren och skickas via
// reläservern till läraren. Hela tavlan skickas vid varje (åter)anslutning,
// så inget går förlorat om kontakten bryts.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const joinView = $('joinView');
  const boardView = $('boardView');
  const joinForm = $('joinForm');
  const roomInput = $('roomInput');
  const nameInput = $('nameInput');
  const joinError = $('joinError');
  const statusEl = $('status');
  const stage = $('stage');
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const penOnlyBox = $('penOnly');

  const board = new Board();
  const diag = makeDiag($('diag'));
  diag.add('webbläsare: ' + navigator.userAgent);
  let room = '';
  let name = '';
  // Varje flik är en egen tavla hos läraren: id:t består av en del per
  // webbläsare (localStorage) och en del per flik (sessionStorage), så att
  // flera flikar på samma dator inte blandas ihop men en omladdning behåller tavlan.
  let deviceId = storage.get('wb-client-id');
  if (!deviceId) {
    deviceId = randomId();
    storage.set('wb-client-id', deviceId);
  }
  let tabId = storage.get('wb-tab-id', true);
  if (!tabId) {
    tabId = randomId();
    storage.set('wb-tab-id', tabId, true);
  }
  const clientId = deviceId + '-' + tabId;

  // ---------- Startskärm ----------
  const hashRoom = normalizeRoomCode(decodeURIComponent(location.hash.slice(1)) || new URLSearchParams(location.search).get('rum'));
  if (hashRoom) roomInput.value = hashRoom;
  nameInput.value = storage.get('wb-name') || '';
  if (hashRoom) nameInput.focus(); else roomInput.focus();

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeRoomCode(roomInput.value);
    if (code.length < 4) {
      joinError.textContent = 'Skriv rumskoden som står på tavlan.';
      joinError.hidden = false;
      return;
    }
    joinError.hidden = true;
    room = code;
    name = nameInput.value.trim().slice(0, 40);
    storage.set('wb-name', name);
    history.replaceState(null, '', '#' + room);
    startBoard();
  });

  // ---------- Ritvy ----------
  let tool = 'pen';
  let color = PEN_COLORS[0].value;
  let width = PEN_WIDTHS[1].value;
  let penSeen = storage.get('wb-pen-seen') === '1';
  penOnlyBox.checked = penSeen;
  penOnlyBox.addEventListener('change', () => {
    storage.set('wb-pen-seen', penOnlyBox.checked ? '1' : '0');
  });

  function startBoard() {
    joinView.hidden = true;
    boardView.hidden = false;
    $('myName').textContent = name;
    document.title = (name ? name + ' – ' : '') + 'Whiteboard ' + room;
    buildToolbar();
    restoreStrokes();
    updateToolbar();
    resize();
    new ResizeObserver(resize).observe(stage);
    window.addEventListener('orientationchange', () => setTimeout(resize, 200));
    connect();
  }

  function buildToolbar() {
    const colors = $('colors');
    for (const c of PEN_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool';
      b.title = c.name;
      b.setAttribute('aria-label', c.name);
      b.innerHTML = `<span class="swatch" style="background:${c.value}"></span>`;
      b.addEventListener('click', () => {
        color = c.value;
        tool = 'pen';
        updateToolbar();
      });
      b.dataset.color = c.value;
      colors.appendChild(b);
    }
    const widths = $('widths');
    PEN_WIDTHS.forEach((w, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool';
      b.title = w.name;
      b.setAttribute('aria-label', w.name);
      const px = 6 + i * 6;
      b.innerHTML = `<span class="dot" style="width:${px}px;height:${px}px"></span>`;
      b.addEventListener('click', () => {
        width = w.value;
        tool = 'pen';
        updateToolbar();
      });
      b.dataset.width = String(w.value);
      widths.appendChild(b);
    });
    $('eraser').addEventListener('click', () => {
      tool = tool === 'eraser' ? 'pen' : 'eraser';
      updateToolbar();
    });
    $('undo').addEventListener('click', undo);
    $('clear').addEventListener('click', () => {
      if (board.isEmpty() || confirm('Rensa hela tavlan?')) clearBoard(true);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      }
    });
    updateToolbar();
  }

  function updateToolbar() {
    for (const b of document.querySelectorAll('#colors .tool')) {
      b.classList.toggle('active', tool === 'pen' && b.dataset.color === color);
    }
    for (const b of document.querySelectorAll('#widths .tool')) {
      b.classList.toggle('active', tool === 'pen' && Number(b.dataset.width) === width);
    }
    $('eraser').classList.toggle('active', tool === 'eraser');
    $('undo').disabled = board.isEmpty();
  }

  function resize() {
    fitCanvas(canvas, stage);
    renderBoard(ctx, board, canvas.width, canvas.height);
  }

  function redraw() {
    renderBoard(ctx, board, canvas.width, canvas.height);
    updateToolbar();
  }

  // ---------- Lokal lagring ----------
  const storageKey = () => 'wb-strokes-' + room + '-' + tabId;
  function restoreStrokes() {
    try {
      const saved = JSON.parse(storage.get(storageKey()) || '{}');
      board.replace(Array.isArray(saved.strokes) ? saved.strokes : []);
    } catch (e) {
      board.clear();
    }
    pruneOldStrokes();
  }
  // Rensa bort sparade tavlor från gamla flikar och lektioner.
  function pruneOldStrokes() {
    const limit = Date.now() - 2 * 24 * 60 * 60 * 1000;
    for (const key of storage.keys()) {
      if (!key.startsWith('wb-strokes-') || key === storageKey()) continue;
      try {
        const saved = JSON.parse(storage.get(key) || '{}');
        if (!saved.t || saved.t < limit) storage.remove(key);
      } catch (e) {
        storage.remove(key);
      }
    }
  }
  let saveTimer = 0;
  function saveStrokes() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        storage.set(storageKey(), JSON.stringify({ t: Date.now(), strokes: board.strokes }));
      } catch (e) {
        /* fullt lagringsutrymme: ignorera */
      }
    }, 300);
  }

  // ---------- Ritning ----------
  let current = null; // pågående streck
  let activePointer = null;
  let pendingPoints = [];
  let flushTimer = 0;
  let drawnCount = 0;

  function pointFrom(e, rect) {
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    let p = e.pointerType === 'pen' ? e.pressure : 0.5;
    if (!(p > 0)) p = 0.5;
    return [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000, Math.round(p * 100) / 100];
  }

  function ignore(e) {
    if (e.pointerType === 'pen' && !penSeen) {
      penSeen = true;
      penOnlyBox.checked = true;
      storage.set('wb-pen-seen', '1');
    }
    return e.pointerType === 'touch' && penOnlyBox.checked;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // iOS Safari: stoppa scroll, zoom och långtryck på ritytan även när
  // touch-action inte räcker. Måste vara icke-passiva lyssnare.
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    stage.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (ignore(e) || activePointer !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    activePointer = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignorera */ }
    const rect = canvas.getBoundingClientRect();
    current = board.start({
      id: randomId(),
      tool,
      color,
      width: tool === 'eraser' ? ERASER_WIDTH : width,
      points: [pointFrom(e, rect)],
    });
    drawnCount = 0;
    drawStroke(ctx, current, canvas.width, canvas.height, 0);
    drawnCount = 1;
    send({ t: 'ss', s: current });
    pendingPoints = [];
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!current || e.pointerId !== activePointer) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const added = [];
    for (const ev of events.length ? events : [e]) {
      const pt = pointFrom(ev, rect);
      const last = current.points[current.points.length - 1];
      const dx = (pt[0] - last[0]) * rect.width;
      const dy = (pt[1] - last[1]) * rect.height;
      if (dx * dx + dy * dy < 1) continue;
      current.points.push(pt);
      added.push(pt);
    }
    if (!added.length) return;
    drawStroke(ctx, current, canvas.width, canvas.height, drawnCount);
    drawnCount = current.points.length;
    pendingPoints.push(...added);
    if (!flushTimer) flushTimer = setTimeout(flushPoints, 100);
  });

  function finishStroke(e) {
    if (!current || e.pointerId !== activePointer) return;
    flushPoints();
    send({ t: 'se', id: current.id });
    current = null;
    activePointer = null;
    saveStrokes();
    updateToolbar();
  }
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);
  canvas.addEventListener('lostpointercapture', (e) => {
    if (current && e.pointerId === activePointer) finishStroke(e);
  });

  function flushPoints() {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (current && pendingPoints.length) {
      send({ t: 'sp', id: current.id, p: pendingPoints });
    }
    pendingPoints = [];
  }

  function undo() {
    if (current) return;
    const s = board.undo();
    if (!s) return;
    send({ t: 'undo', id: s.id });
    redraw();
    saveStrokes();
  }

  function clearBoard(notify) {
    current = null;
    activePointer = null;
    board.clear();
    redraw();
    saveStrokes();
    if (notify) send({ t: 'clear' });
  }

  // ---------- Anslutning till läraren ----------
  let relay = null;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status ' + cls;
    diag.add('status: ' + text);
  }

  function connect() {
    const base = relayBase();
    if (!base) {
      setStatus('Reläservern är inte inställd (config.js)', 'err');
      return;
    }
    setStatus('Ansluter…', 'warn');
    const url = base + '/room/' + room + '?role=student&client=' + encodeURIComponent(clientId) + '&name=' + encodeURIComponent(name);
    diag.add('ansluter till ' + url.replace(/\?.*$/, ''));
    relay = new RelaySocket(url, {
      onOpen() {
        send({ t: 'hello', clientId, name, strokes: board.strokes });
      },
      onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.t) {
          case 'ready':
            setStatus('Ansluten till läraren', 'ok');
            break;
          case 'clear':
            clearBoard(false);
            break;
          case 'error':
            diag.add('servern svarade: ' + msg.code + ' ' + (msg.reason || ''));
            break;
          default:
            break;
        }
      },
      onClose(code, reason) {
        diag.add('anslutningen stängdes (' + code + (reason ? ' ' + reason : '') + ')');
        if (code === 4404) {
          setStatus('Läraren har inte öppnat rummet ännu, väntar…', 'warn');
          relay.scheduleReconnect(5000);
          return false;
        }
        if (code === 4000) {
          setStatus('Tavlan öppnades i en annan flik', 'err');
          return false;
        }
        if (code === 4001) {
          setStatus('Läraren tog bort din tavla. Ladda om sidan för att gå med igen.', 'err');
          return false;
        }
        if (code === 4400 || code === 4403) {
          setStatus('Kunde inte gå med i rummet (' + (reason || code) + ')', 'err');
          return false;
        }
        setStatus('Tappade kontakten, försöker igen…', 'warn');
        return true;
      },
    });
    relay.connect();
  }

  function send(msg) {
    return relay ? relay.send(msg) : false;
  }

  window.addEventListener('online', () => {
    if (relay && !relay.open) relay.scheduleReconnect(500);
  });
})();
