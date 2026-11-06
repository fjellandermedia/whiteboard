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

  // Sidan används både av elever (elev.html) och av läraren för att rita en
  // uppgift som blir bakgrund på allas tavlor (uppgift.html).
  const taskMode = document.body.dataset.mode === 'task';
  const board = new Board();
  const background = new Board(); // lärarens uppgift, ritas under elevens streck
  const layer = document.createElement('canvas'); // elevens streck
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
  let roomKey = '';
  if (taskMode) {
    room = hashRoom;
    roomKey = room ? roomKeyFor(room) : '';
    name = 'Uppgift';
    if (!room || !roomKey) {
      joinView.hidden = false;
      joinError.textContent = 'Öppna uppgiftssidan via knappen Uppgift på lärarsidan.';
      joinError.hidden = false;
    }
  } else {
    if (hashRoom) roomInput.value = hashRoom;
    nameInput.value = storage.get('wb-name') || '';
    if (hashRoom) nameInput.focus(); else roomInput.focus();
  }

  joinForm && joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeRoomCode(roomInput.value);
    if (code.length < ROOM_CODE_MIN) {
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
    $('myName').textContent = taskMode ? '' : name;
    document.title = taskMode ? 'Uppgift – Whiteboard ' + room : (name ? name + ' – ' : '') + 'Whiteboard ' + room;
    if (taskMode) {
      $('sendTask').addEventListener('click', sendTask);
      $('removeTask').addEventListener('click', removeTask);
      $('backToBoards').addEventListener('click', backToBoards);
    }
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
        if (tool !== 'text') tool = 'pen';
        updateToolbar();
        if (typeof previewText === 'function') previewText();
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
    if ($('textTool')) {
      $('textTool').addEventListener('click', () => {
        tool = tool === 'text' ? 'pen' : 'text';
        updateToolbar();
      });
      setupTextEditor();
    }
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
      b.classList.toggle('active', (tool === 'pen' || tool === 'text') && b.dataset.color === color);
    }
    for (const b of document.querySelectorAll('#widths .tool')) {
      b.classList.toggle('active', tool === 'pen' && Number(b.dataset.width) === width);
    }
    $('eraser').classList.toggle('active', tool === 'eraser');
    if ($('textTool')) $('textTool').classList.toggle('active', tool === 'text');
    canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
    $('undo').disabled = board.isEmpty();
  }

  function resize() {
    fitCanvas(canvas, stage);
    renderAll();
  }

  // Bakgrund + elevens lager ritas ihop på den synliga canvasen.
  function renderAll() {
    renderLayered(ctx, background, board, canvas.width, canvas.height, layer);
  }

  // Under ett pågående streck ritas bara det nya på lagret, sedan sätts bilden ihop.
  function composite() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    drawStrokes(ctx, background.strokes, w, h);
    ctx.drawImage(layer, 0, 0);
  }

  function redraw() {
    renderAll();
    updateToolbar();
  }

  // ---------- Lokal lagring ----------
  const storageKey = () => (taskMode ? 'wb-task-' + room : 'wb-strokes-' + room + '-' + tabId);
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
    if (tool === 'text') {
      openTextEditorAt(e);
      return;
    }
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
    if (layer.width !== canvas.width || layer.height !== canvas.height) renderAll();
    drawStroke(layer.getContext('2d'), current, canvas.width, canvas.height, 0);
    drawnCount = 1;
    composite();
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
    drawStroke(layer.getContext('2d'), current, canvas.width, canvas.height, drawnCount);
    drawnCount = current.points.length;
    composite();
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
    // Text ligger alltid överst: rita om när ett streck korsat text.
    if (board.hasText()) renderAll();
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

  // ---------- Textverktyg (bara uppgift.html) ----------
  const TEXT_SYMBOLS = ['√', 'π', '²', '³', '½', '×', '·', '÷', '±', '≤', '≥', '≠', '≈', '°', '∞', '∠', 'Δ', 'α', 'β', 'θ', '→'];
  let editingText = null; // { id, x, y } för textobjektet som redigeras

  function setupTextEditor() {
    const sizeSel = $('textSize');
    for (const t of TEXT_SIZES) {
      const o = document.createElement('option');
      o.value = String(t.value);
      o.textContent = t.name;
      if (t.id === 'medium') o.selected = true;
      sizeSel.appendChild(o);
    }
    const symbols = $('symbols');
    for (const sym of TEXT_SYMBOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = sym;
      b.title = 'Infoga ' + sym;
      b.addEventListener('click', () => insertSymbol(sym));
      symbols.appendChild(b);
    }
    for (const snippet of [['x^2', 'Upphöjt'], ['sqrt(x)', 'Roten ur'], ['frac(a,b)', 'Bråk']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = snippet[0];
      b.title = snippet[1];
      b.addEventListener('click', () => insertSymbol(snippet[0]));
      symbols.appendChild(b);
    }
    $('textDone').addEventListener('click', commitText);
    $('textCancel').addEventListener('click', closeTextEditor);
    $('textDelete').addEventListener('click', () => {
      if (editingText && editingText.existing) {
        board.remove(editingText.id);
        redraw();
        saveStrokes();
      }
      closeTextEditor();
    });
    $('textInput').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTextEditor();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commitText();
      }
    });
    $('textInput').addEventListener('input', previewText);
    sizeSel.addEventListener('change', previewText);
  }

  function insertSymbol(text) {
    const ta = $('textInput');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    ta.focus();
    previewText();
  }

  function openTextEditorAt(e) {
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);
    // Klick på befintlig text öppnar den för redigering.
    let hit = null;
    for (const item of board.strokes) {
      if (item.tool !== 'text') continue;
      const b = textItemBounds(ctx, item, canvas.width, canvas.height);
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) hit = item;
    }
    const editor = $('textEditor');
    if (hit) {
      editingText = { id: hit.id, x: hit.x, y: hit.y, existing: true, original: hit };
      $('textInput').value = hit.text;
      $('textSize').value = String(hit.size);
      color = hit.color;
    } else {
      editingText = { id: randomId(), x: px / canvas.width, y: py / canvas.height, existing: false };
      $('textInput').value = '';
    }
    $('textDelete').hidden = !editingText.existing;
    // Placera redigeringsrutan vid klicket, men inom ritytan.
    const stageRect = stage.getBoundingClientRect();
    const left = Math.min(Math.max(0, e.clientX - stageRect.left), stageRect.width - 340);
    const top = Math.min(Math.max(0, e.clientY - stageRect.top + 12), stageRect.height - 200);
    editor.style.left = left + 'px';
    editor.style.top = top + 'px';
    editor.hidden = false;
    updateToolbar();
    $('textInput').focus();
    previewText();
  }

  // Visar texten på tavlan medan den skrivs.
  function previewText() {
    if (!editingText) return;
    const text = $('textInput').value;
    const item = { id: editingText.id, tool: 'text', x: editingText.x, y: editingText.y, size: Number($('textSize').value), color, text };
    renderAll();
    if (text.trim()) drawTextItem(ctx, item, canvas.width, canvas.height);
  }

  function commitText() {
    if (!editingText) return;
    const text = $('textInput').value.replace(/\s+$/, '');
    if (!text.trim()) {
      if (editingText.existing) board.remove(editingText.id);
    } else {
      board.start({ id: editingText.id, tool: 'text', x: editingText.x, y: editingText.y, size: Number($('textSize').value), color, text });
    }
    editingText = null;
    $('textEditor').hidden = true;
    redraw();
    saveStrokes();
  }

  function closeTextEditor() {
    editingText = null;
    $('textEditor').hidden = true;
    redraw();
  }

  // ---------- Uppgift (bara uppgift.html) ----------
  function sendTask() {
    if (current) return;
    if (!send({ t: 'background', strokes: board.strokes }, true)) {
      alert('Ingen kontakt med servern just nu. Försök igen om en stund.');
      return;
    }
    setStatus(board.isEmpty() ? 'Uppgiften är borttagen hos alla' : 'Uppgiften är utskickad till alla', 'ok');
  }

  // Tillbaka till lärarens översikt: den ligger normalt kvar i fliken som
  // öppnade den här sidan, annars öppnas den här.
  function backToBoards() {
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.focus();
        window.close();
        return;
      } catch (e) { /* fortsätt nedan */ }
    }
    location.href = 'index.html';
  }

  function removeTask() {
    if (board.isEmpty() && !confirm('Ta bort uppgiften från allas tavlor?')) return;
    if (!board.isEmpty() && !confirm('Rensa uppgiften och ta bort den från allas tavlor?')) return;
    board.clear();
    redraw();
    saveStrokes();
    sendTask();
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
    const url = taskMode
      ? base + '/room/' + room + '?role=task&key=' + encodeURIComponent(roomKey)
      : base + '/room/' + room + '?role=student&client=' + encodeURIComponent(clientId) + '&name=' + encodeURIComponent(name);
    diag.add('ansluter till ' + url.replace(/\?.*$/, ''));
    relay = new RelaySocket(url, {
      onOpen() {
        if (!taskMode) send({ t: 'hello', clientId, name, strokes: board.strokes });
      },
      onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        switch (msg.t) {
          case 'ready':
            setStatus(taskMode ? 'Ansluten. Rita uppgiften och skicka ut den.' : 'Ansluten till läraren', 'ok');
            break;
          case 'background':
            if (taskMode) {
              // Hämta den utskickade uppgiften om det inte finns något lokalt utkast.
              if (board.isEmpty() && Array.isArray(msg.strokes) && msg.strokes.length) {
                board.replace(msg.strokes);
                redraw();
                saveStrokes();
              }
            } else {
              background.replace(Array.isArray(msg.strokes) ? msg.strokes : []);
              renderAll();
            }
            break;
          case 'clear':
            if (!taskMode) clearBoard(false);
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

  function send(msg, force) {
    // Uppgiftssidan skickar bara hela uppgiften, inte enskilda streck.
    if (taskMode && !force) return false;
    return relay ? relay.send(msg) : false;
  }

  window.addEventListener('online', () => {
    if (relay && !relay.open) relay.scheduleReconnect(500);
  });

  // Uppgiftssidan startar direkt, utan startskärm.
  if (taskMode && room && roomKey) startBoard();
})();
