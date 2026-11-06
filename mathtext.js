// Text med enkel matematiknotation, ritad på canvas.
//
//   x^2          upphöjt (ett tecken, ett tal eller {grupp})
//   a_1          nedsänkt
//   sqrt(x+1)    roten ur, även √(…) eller sqrt{…}
//   frac(a,b)    bråk, även frac{a}{b}
//   {…}          grupp
//
// Ett textobjekt på tavlan: { id, tool: 'text', x, y, size, color, text }
// där x, y är övre vänstra hörnet och size är texthöjden, alla relativt
// tavlans bredd (0–1).

const TEXT_SIZES = [
  { id: 'small', name: 'Liten', value: 0.022 },
  { id: 'medium', name: 'Mellan', value: 0.032 },
  { id: 'large', name: 'Stor', value: 0.048 },
];
const TEXT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const TEXT_LINE_HEIGHT = 1.35;

// ---------- Tolkning ----------

function parseMath(text) {
  let i = 0;
  const src = String(text || '');

  function parseGroupBody(close) {
    const nodes = parseSeq(close);
    if (src[i] === close) i++;
    return { type: 'seq', nodes };
  }

  function parseArg() {
    // Argument till ^ och _: {grupp}, ett tal (med ev. minus) eller ett tecken.
    if (src[i] === '{') {
      i++;
      return parseGroupBody('}');
    }
    if (src[i] === '(') {
      i++;
      const g = parseGroupBody(')');
      return { type: 'seq', nodes: [{ type: 'text', text: '(' }, g, { type: 'text', text: ')' }] };
    }
    const m = /^-?\d+|^./u.exec(src.slice(i));
    if (!m) return { type: 'seq', nodes: [] };
    i += m[0].length;
    return { type: 'text', text: m[0] };
  }

  function parseFuncArg() {
    // Argument till sqrt och frac: (…) eller {…}, annars ett tecken.
    while (src[i] === ' ') i++;
    if (src[i] === '{') {
      i++;
      return parseGroupBody('}');
    }
    if (src[i] === '(') {
      i++;
      return parseGroupBody(')');
    }
    return parseArg();
  }

  function parseSeq(close) {
    const nodes = [];
    let buf = '';
    const flush = () => {
      if (buf) nodes.push({ type: 'text', text: buf });
      buf = '';
    };
    while (i < src.length) {
      const c = src[i];
      if (c === close) break;
      if (c === '\\' && i + 1 < src.length && !/[a-z]/i.test(src[i + 1])) {
        buf += src[i + 1];
        i += 2;
        continue;
      }
      if (c === '^' || c === '_') {
        i++;
        flush();
        nodes.push({ type: c === '^' ? 'sup' : 'sub', child: parseArg() });
        continue;
      }
      if (c === '{') {
        i++;
        flush();
        nodes.push(parseGroupBody('}'));
        continue;
      }
      const rest = src.slice(i);
      let m = /^(\\sqrt|sqrt|√)\s*(?=[({]|.)/u.exec(rest);
      if (m) {
        i += m[1].length;
        flush();
        nodes.push({ type: 'sqrt', child: parseFuncArg() });
        continue;
      }
      m = /^(\\frac|frac)\s*(?=[({])/.exec(rest);
      if (m) {
        i += m[1].length;
        flush();
        while (src[i] === ' ') i++;
        let num;
        let den;
        if (src[i] === '(') {
          // frac(a,b): dela vid första kommat på nivå 0
          i++;
          num = { type: 'seq', nodes: parseSeq(',') };
          if (src[i] === ',') i++;
          den = parseGroupBody(')');
        } else {
          num = parseFuncArg();
          den = parseFuncArg();
        }
        nodes.push({ type: 'frac', num, den });
        continue;
      }
      buf += c;
      i++;
    }
    flush();
    return nodes;
  }

  return { type: 'seq', nodes: parseSeq(undefined) };
}

// ---------- Mått och ritning ----------
// Varje nod mäts till { w, asc, desc } i pixlar för en given textstorlek (px).

function fontFor(px) {
  return Math.max(1, px) + 'px ' + TEXT_FONT;
}

function measureNode(ctx, node, px) {
  switch (node.type) {
    case 'text': {
      ctx.font = fontFor(px);
      return { w: ctx.measureText(node.text).width, asc: px * 0.8, desc: px * 0.22 };
    }
    case 'seq': {
      let w = 0;
      let asc = px * 0.8;
      let desc = px * 0.22;
      for (const n of node.nodes) {
        const m = measureNode(ctx, n, px);
        w += m.w;
        asc = Math.max(asc, m.asc);
        desc = Math.max(desc, m.desc);
      }
      return { w, asc, desc };
    }
    case 'sup': {
      const m = measureNode(ctx, node.child, px * 0.62);
      const raise = px * 0.42;
      return { w: m.w + px * 0.04, asc: Math.max(px * 0.8, raise + m.asc), desc: px * 0.22 };
    }
    case 'sub': {
      const m = measureNode(ctx, node.child, px * 0.62);
      const lower = px * 0.2;
      return { w: m.w + px * 0.04, asc: px * 0.8, desc: Math.max(px * 0.22, lower + m.desc) };
    }
    case 'sqrt': {
      const m = measureNode(ctx, node.child, px);
      const pad = px * 0.08;
      return { w: px * 0.6 + m.w + pad * 2, asc: m.asc + px * 0.18, desc: m.desc };
    }
    case 'frac': {
      const n = measureNode(ctx, node.num, px * 0.9);
      const d = measureNode(ctx, node.den, px * 0.9);
      const axis = px * 0.33; // bråkstreckets höjd över baslinjen
      const gap = px * 0.1;
      return {
        w: Math.max(n.w, d.w) + px * 0.24,
        asc: axis + gap + n.desc + n.asc,
        desc: -axis + gap + d.asc + d.desc,
      };
    }
    default:
      return { w: 0, asc: 0, desc: 0 };
  }
}

function drawNode(ctx, node, x, baseline, px) {
  switch (node.type) {
    case 'text':
      ctx.font = fontFor(px);
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(node.text, x, baseline);
      return;
    case 'seq': {
      let cx = x;
      for (const n of node.nodes) {
        drawNode(ctx, n, cx, baseline, px);
        cx += measureNode(ctx, n, px).w;
      }
      return;
    }
    case 'sup':
      drawNode(ctx, node.child, x + px * 0.02, baseline - px * 0.42, px * 0.62);
      return;
    case 'sub':
      drawNode(ctx, node.child, x + px * 0.02, baseline + px * 0.2, px * 0.62);
      return;
    case 'sqrt': {
      const m = measureNode(ctx, node.child, px);
      const pad = px * 0.08;
      const top = baseline - m.asc - px * 0.12;
      const bottom = baseline + m.desc;
      const signW = px * 0.6;
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = Math.max(1, px * 0.06);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, baseline - px * 0.3);
      ctx.lineTo(x + signW * 0.3, baseline - px * 0.38);
      ctx.lineTo(x + signW * 0.55, bottom);
      ctx.lineTo(x + signW, top);
      ctx.lineTo(x + signW + m.w + pad * 2, top);
      ctx.stroke();
      ctx.restore();
      drawNode(ctx, node.child, x + signW + pad, baseline, px);
      return;
    }
    case 'frac': {
      const inner = px * 0.9;
      const n = measureNode(ctx, node.num, inner);
      const d = measureNode(ctx, node.den, inner);
      const w = Math.max(n.w, d.w) + px * 0.24;
      const axis = baseline - px * 0.33;
      const gap = px * 0.1;
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = Math.max(1, px * 0.06);
      ctx.beginPath();
      ctx.moveTo(x + px * 0.04, axis);
      ctx.lineTo(x + w - px * 0.04, axis);
      ctx.stroke();
      ctx.restore();
      drawNode(ctx, node.num, x + (w - n.w) / 2, axis - gap - n.desc, inner);
      drawNode(ctx, node.den, x + (w - d.w) / 2, axis + gap + d.asc, inner);
      return;
    }
    default:
  }
}

// Mäter ett helt textobjekt (flera rader). Returnerar rader med mått och total storlek i px.
function layoutText(ctx, item, w) {
  const px = (item.size || TEXT_SIZES[1].value) * w;
  const lines = String(item.text || '').split('\n').map((line) => {
    const tree = parseMath(line);
    const m = measureNode(ctx, tree, px);
    return { tree, w: m.w, asc: Math.max(m.asc, px * 0.8), desc: Math.max(m.desc, px * 0.22) };
  });
  let height = 0;
  let width = 0;
  for (const l of lines) {
    l.h = Math.max(l.asc + l.desc, px * TEXT_LINE_HEIGHT);
    height += l.h;
    width = Math.max(width, l.w);
  }
  return { px, lines, width, height };
}

function drawTextItem(ctx, item, w, h) {
  const layout = layoutText(ctx, item, w);
  ctx.save();
  ctx.fillStyle = item.color || '#1d1d1b';
  let y = item.y * h;
  for (const line of layout.lines) {
    const extra = (line.h - (line.asc + line.desc)) / 2;
    drawNode(ctx, line.tree, item.x * w, y + extra + line.asc, layout.px);
    y += line.h;
  }
  ctx.restore();
}

// Rektangel (i pixlar) som ett textobjekt upptar, för att kunna klicka på det.
function textItemBounds(ctx, item, w, h) {
  const layout = layoutText(ctx, item, w);
  return { x: item.x * w, y: item.y * h, w: Math.max(layout.width, layout.px), h: layout.height };
}
