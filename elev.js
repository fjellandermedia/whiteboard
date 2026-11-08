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
  // Uppgiftssidan fungerar även utan rum: då kan man förbereda och spara
  // uppgifter, men inte skicka ut dem.
  const taskOffline = taskMode && (!hashRoom || !roomKeyFor(hashRoom));
  if (taskMode) {
    room = hashRoom;
    roomKey = room ? roomKeyFor(room) : '';
    name = 'Uppgift';
  } else {
    roomInput.value = hashRoom || storage.get('wb-last-room') || '';
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
    storage.set('wb-last-room', room);
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
    if (joinView) joinView.hidden = true;
    boardView.hidden = false;
    $('myName').textContent = taskMode ? '' : name;
    document.title = taskMode ? 'Uppgift – Whiteboard ' + room : (name ? name + ' – ' : '') + 'Whiteboard ' + room;
    if (taskMode) {
      $('sendTask').addEventListener('click', sendTask);
      $('removeTask').addEventListener('click', removeTask);
      $('backToBoards').addEventListener('click', backToBoards);
      setupSavedTasks();
      if (taskOffline) {
        $('sendTask').disabled = true;
        $('removeTask').disabled = true;
        $('sendTask').title = 'Öppna uppgiftssidan via knappen Uppgift på lärarsidan för att kunna skicka.';
      }
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
  const storageKey = () => (taskMode ? 'wb-task-' + (room || 'utkast') : 'wb-strokes-' + room + '-' + tabId);
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
    const templates = $('templates');
    for (const t of [
      ['sup', 'x²', 'Upphöjt till. Markera det som ska bli exponent, eller skriv exponenten efteråt.'],
      ['sub', 'x₁', 'Nedsänkt (index)'],
      ['sqrt', '√x', 'Roten ur. Markera uttrycket först, eller skriv det efteråt.'],
      ['frac', 'a⁄b', 'Bråk med täljare och nämnare'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'template';
      b.textContent = t[1];
      b.title = t[2];
      b.addEventListener('click', () => applyTemplate(t[0]));
      templates.appendChild(b);
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

  // Lägger in en mattemall runt markerad text, eller med en markerad
  // platshållare som skrivs över. Läraren behöver inte kunna notationen.
  function applyTemplate(kind) {
    const ta = $('textInput');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const sel = ta.value.slice(start, end);
    let ins;
    let selFrom;
    let selTo;
    switch (kind) {
      case 'sup': {
        const arg = sel || '2';
        ins = '^{' + arg + '}';
        selFrom = start + 2;
        selTo = selFrom + arg.length;
        break;
      }
      case 'sub': {
        const arg = sel || '1';
        ins = '_{' + arg + '}';
        selFrom = start + 2;
        selTo = selFrom + arg.length;
        break;
      }
      case 'sqrt': {
        const arg = sel || 'x';
        ins = 'sqrt(' + arg + ')';
        selFrom = start + 5;
        selTo = selFrom + arg.length;
        break;
      }
      case 'frac': {
        let num = sel || 'a';
        let den = 'b';
        const slash = sel.indexOf('/');
        if (slash > 0) {
          num = sel.slice(0, slash).trim();
          den = sel.slice(slash + 1).trim() || 'b';
        }
        ins = 'frac(' + num + ', ' + den + ')';
        selFrom = start + 5;
        selTo = selFrom + num.length;
        break;
      }
      default:
        return;
    }
    ta.value = ta.value.slice(0, start) + ins + ta.value.slice(end);
    if (sel) {
      // Markerad text har satts in i mallen: fortsätt skriva efter den.
      ta.selectionStart = ta.selectionEnd = start + ins.length;
    } else {
      ta.setSelectionRange(selFrom, selTo);
    }
    ta.focus();
    previewText();
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
    // Placera redigeringsrutan under texten så att förhandsvisningen syns,
    // eller ovanför om den inte får plats, men alltid inom ritytan.
    const stageRect = stage.getBoundingClientRect();
    const lineGap = Number($('textSize').value) * rect.width * TEXT_LINE_HEIGHT * 2.5;
    const editorH = 360;
    const left = Math.min(Math.max(0, e.clientX - stageRect.left), Math.max(0, stageRect.width - 340));
    let top = e.clientY - stageRect.top + lineGap;
    if (top + editorH > stageRect.height) top = e.clientY - stageRect.top - editorH - 12;
    top = Math.min(Math.max(0, top), Math.max(0, stageRect.height - editorH));
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

  // ---------- Sparade uppgifter (i webbläsaren) ----------
  const SAVED_KEY = 'wb-saved-tasks';
  let currentSavedId = null;

  function readSaved() {
    try {
      const list = JSON.parse(storage.get(SAVED_KEY) || '[]');
      return Array.isArray(list) ? list.filter((t) => t && t.id && Array.isArray(t.strokes)) : [];
    } catch (e) {
      return [];
    }
  }

  function writeSaved(list) {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      alert('Det gick inte att spara: webbläsarens lagringsutrymme är fullt. Ta bort någon sparad uppgift eller exportera dem som filer.');
      return false;
    }
  }

  function renderSavedSelect() {
    const sel = $('savedSelect');
    const list = readSaved().sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const chosen = sel.value;
    sel.innerHTML = '<option value="">Välj sparad uppgift…</option>';
    for (const t of list) {
      const o = document.createElement('option');
      o.value = t.id;
      const d = t.updated ? new Date(t.updated) : null;
      o.textContent = t.name + (d ? ' (' + d.toLocaleDateString('sv-SE') + ')' : '');
      sel.appendChild(o);
    }
    sel.value = list.some((t) => t.id === chosen) ? chosen : currentSavedId || '';
    const cur = list.find((t) => t.id === currentSavedId);
    $('savedName').textContent = cur ? 'Laddad: ' + cur.name : '';
    $('savedName').className = 'status ' + (cur ? 'ok' : '');
    const has = !!sel.value;
    $('loadSaved').disabled = !has;
    $('deleteSaved').disabled = !has;
  }

  function setupSavedTasks() {
    renderSavedSelect();
    $('savedSelect').addEventListener('change', renderSavedSelect);
    $('loadSaved').addEventListener('click', () => loadSavedTask($('savedSelect').value));
    $('saveTask').addEventListener('click', () => saveTask(false));
    $('saveTaskAs').addEventListener('click', () => saveTask(true));
    $('deleteSaved').addEventListener('click', deleteSavedTask);
    $('exportTask').addEventListener('click', exportTask);
    $('importTask').addEventListener('change', (e) => importTasks(e.target.files));
  }

  function saveTask(asNew) {
    if (current) return;
    if (board.isEmpty()) {
      alert('Tavlan är tom. Rita eller skriv uppgiften först.');
      return;
    }
    const list = readSaved();
    let entry = asNew ? null : list.find((t) => t.id === currentSavedId);
    if (!entry) {
      const suggested = entry ? entry.name : firstTextLine() || 'Uppgift ' + (list.length + 1);
      const name = prompt('Namn på uppgiften:', suggested);
      if (name === null) return;
      entry = { id: randomId(), name: name.trim() || suggested, strokes: [], updated: 0 };
      list.push(entry);
    }
    entry.strokes = JSON.parse(JSON.stringify(board.strokes));
    entry.updated = Date.now();
    if (!writeSaved(list)) return;
    currentSavedId = entry.id;
    renderSavedSelect();
    setStatus('Sparade "' + entry.name + '" i den här webbläsaren', 'ok');
  }

  // Första textraden på tavlan, som förslag till namn.
  function firstTextLine() {
    const t = board.strokes.find((s) => s.tool === 'text');
    return t ? t.text.split('\n')[0].trim().slice(0, 40) : '';
  }

  function loadSavedTask(id) {
    const entry = readSaved().find((t) => t.id === id);
    if (!entry) return;
    if (!board.isEmpty() && id !== currentSavedId && !confirm('Ersätta det som finns på tavlan med "' + entry.name + '"? Spara först om du vill behålla det.')) return;
    closeTextEditor();
    board.replace(entry.strokes);
    currentSavedId = entry.id;
    redraw();
    saveStrokes();
    renderSavedSelect();
    setStatus('Laddade "' + entry.name + '". Tryck Skicka till alla när du vill dela ut den.', 'ok');
  }

  function deleteSavedTask() {
    const id = $('savedSelect').value;
    const list = readSaved();
    const entry = list.find((t) => t.id === id);
    if (!entry || !confirm('Ta bort den sparade uppgiften "' + entry.name + '"?')) return;
    writeSaved(list.filter((t) => t.id !== id));
    if (currentSavedId === id) currentSavedId = null;
    renderSavedSelect();
  }

  function exportTask() {
    const sel = $('savedSelect').value;
    const list = readSaved();
    let items;
    if (sel && !confirm('Exportera bara den valda uppgiften? Avbryt för att exportera alla sparade uppgifter i en fil.')) {
      items = list;
    } else if (sel) {
      items = list.filter((t) => t.id === sel);
    } else {
      items = list;
    }
    if (!items.length) {
      if (board.isEmpty()) {
        alert('Det finns inget att exportera.');
        return;
      }
      items = [{ name: firstTextLine() || 'Uppgift', strokes: board.strokes }];
    }
    const data = { whiteboardTasks: items.map((t) => ({ name: t.name, strokes: t.strokes, updated: t.updated || Date.now() })) };
    const base = items.length === 1 ? safeFileName(items[0].name, 'uppgift') : 'uppgifter';
    downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), base + '.json');
  }

  async function importTasks(files) {
    const list = readSaved();
    let added = 0;
    for (const file of files || []) {
      try {
        const data = JSON.parse(await file.text());
        const items = Array.isArray(data.whiteboardTasks) ? data.whiteboardTasks : Array.isArray(data) ? data : [data];
        for (const t of items) {
          if (!t || !Array.isArray(t.strokes)) continue;
          const probe = new Board();
          probe.replace(t.strokes);
          if (probe.isEmpty()) continue;
          let name = String(t.name || file.name.replace(/\.json$/i, '')).slice(0, 60) || 'Importerad uppgift';
          while (list.some((x) => x.name === name)) name += ' (kopia)';
          list.push({ id: randomId(), name, strokes: probe.strokes, updated: Number(t.updated) || Date.now() });
          added++;
        }
      } catch (e) {
        alert('Kunde inte läsa filen ' + file.name + '.');
      }
    }
    $('importTask').value = '';
    if (!added) return;
    if (writeSaved(list)) {
      renderSavedSelect();
      setStatus('Importerade ' + added + ' uppgift' + (added === 1 ? '' : 'er'), 'ok');
    }
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
    if (taskOffline) {
      setStatus('Inte ansluten till något rum. Här kan du förbereda och spara uppgifter.', 'warn');
      return;
    }
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
  if (taskMode) startBoard();
})();
