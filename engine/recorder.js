// The session recorder: the slides at 1920×1080 plus the microphone, saved
// as a local file. Taken from the Perch SCF deck's recorder and generalised
// for Markdown slides.
//
// Each slide is painted once, in its final state, onto a 1920×1080 canvas:
// copies of the slides are laid out in an invisible 1920×1080 box (the CSS
// sizes everything from the deck box, so they lay out as a 1920×1080 deck
// would), their SVG drawings are serialised with computed styles and drawn as
// images, and their HTML is painted from its computed layout: text word by
// word, backgrounds, borders, list markers and images. The recording is that
// canvas's stream plus the microphone, through MediaRecorder, with a short
// crossfade when the slide changes. The presenter panel is ordinary page
// content, so it never reaches the canvas, and nothing leaves the browser.

import { formatDuration } from './loader.js';
import { h, buildSlide, drawSlide } from './runtime.js';

export const VW = 1920, VH = 1080;
// avc3 keeps codec settings in-band, which Chrome asks for; Safari offers avc1.
export const MIMES = ['video/mp4;codecs=avc3.640028,mp4a.40.2', 'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
// The format a MediaRecorder MIME type names, such as "MP4 (H.264 and Opus)"
// for video/mp4;codecs=avc1.42000c,opus. Only codecs the type lists are named:
// the same container holds AAC audio in one browser and Opus in another.
export function formatLabel(mime) {
  const m = String(mime || '').toLowerCase();
  const container = /mp4/.test(m.split(';')[0]) ? 'MP4' : 'WebM';
  const codecs = (/codecs=["']?([^"';]+)/.exec(m) || [null, ''])[1];
  const video = /avc[13]|h264/.test(codecs) ? 'H.264' : /av01/.test(codecs) ? 'AV1' : /vp0?9/.test(codecs) ? 'VP9' : /vp0?8/.test(codecs) ? 'VP8' : '';
  const audio = /mp4a|aac/.test(codecs) ? 'AAC' : /opus/.test(codecs) ? 'Opus' : '';
  const named = [video, audio].filter(Boolean);
  return named.length ? `${container} (${named.join(' and ')})` : container;
}
export const pickMime = (ok = m => MediaRecorder.isTypeSupported(m)) => MIMES.find(m => { try { return ok(m); } catch (_) { return false; } }) || '';

const NS = 'http://www.w3.org/2000/svg';
const f2 = n => Math.round(n * 100) / 100;

/* ---------- painting a slide ---------- */

const PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'vector-effect', 'display'];
function inlineStyles(src, dst, symbol) {
  const cs = getComputedStyle(src);
  let css = '';
  PROPS.forEach(p => { const v = cs.getPropertyValue(p); if (v) css += `${p}:${v};`; });
  if (symbol && /\bs-/.test(src.getAttribute('class') || '')) css = css.replace(/(^|;)stroke:[^;]*/, '$1stroke:currentColor');
  else if (!symbol) css += `color:${cs.color};`;
  dst.setAttribute('style', css);
  dst.removeAttribute('class');
  for (let i = 0; i < src.children.length; i++) inlineStyles(src.children[i], dst.children[i], symbol);
}
async function svgImage(el) {
  const r = el.getBoundingClientRect();
  const cl = el.cloneNode(true);
  inlineStyles(el, cl, false);
  cl.setAttribute('xmlns', NS);
  cl.setAttribute('width', f2(r.width));
  cl.setAttribute('height', f2(r.height));
  const defs = document.createElementNS(NS, 'defs');
  const want = new Set(Array.from(cl.querySelectorAll('use')).map(u => (u.getAttribute('href') || '').slice(1)));
  document.querySelectorAll('#defs defs > *').forEach(d => {
    if (d.tagName === 'pattern' || want.has(d.id)) { const c = d.cloneNode(true); inlineStyles(d, c, d.tagName === 'symbol'); defs.appendChild(c); }
  });
  cl.insertBefore(defs, cl.firstChild);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(cl));
  await img.decode();
  return { img, r };
}
function rrect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
const visible = c => !!c && c !== 'transparent' && !/^rgba\([^)]*,\s*0\)$/.test(c);
// Background, inset spread shadows and borders: the box decorations slides use.
function paintBox(g, x, y, w, h, cs) {
  const rad = parseFloat(cs.borderTopLeftRadius) || 0;
  if (visible(cs.backgroundColor)) { g.fillStyle = cs.backgroundColor; rrect(g, x, y, w, h, rad); g.fill(); }
  const side = s => ({ w: parseFloat(cs[`border${s}Width`]) || 0, c: cs[`border${s}Color`], st: cs[`border${s}Style`] });
  const [T, Rr, B, L] = ['Top', 'Right', 'Bottom', 'Left'].map(side);
  const on = s => s.w > 0 && s.st !== 'none' && s.st !== 'hidden' && visible(s.c);
  const bw = on(T) ? T.w : 0;
  const sh = cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow.split(/,(?![^(]*\))/) : [];
  sh.reverse().forEach(part => {
    if (!/inset/.test(part)) return;
    const col = (part.match(/rgba?\([^)]*\)|#[0-9a-f]+/i) || [''])[0];
    const nums = part.replace(col, '').match(/-?[\d.]+px/g) || [];
    const spread = parseFloat(nums[3] || '0');
    if (!col || spread <= 0) return;
    g.lineWidth = spread; g.strokeStyle = col;
    const k = bw + spread / 2;
    rrect(g, x + k, y + k, w - 2 * k, h - 2 * k, rad - k); g.stroke();
  });
  if ([T, Rr, B, L].every(s => on(s) && s.w === T.w && s.c === T.c)) {
    g.lineWidth = T.w; g.strokeStyle = T.c;
    if (T.st === 'dashed') g.setLineDash([T.w * 3, T.w * 2]);
    rrect(g, x + T.w / 2, y + T.w / 2, w - T.w, h - T.w, rad - T.w / 2); g.stroke();
    g.setLineDash([]);
    return;
  }
  const line = (s, x1, y1, x2, y2) => { if (!on(s)) return; g.lineWidth = s.w; g.strokeStyle = s.c; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  line(T, x, y + T.w / 2, x + w, y + T.w / 2);
  line(B, x, y + h - B.w / 2, x + w, y + h - B.w / 2);
  line(L, x + L.w / 2, y, x + L.w / 2, y + h);
  line(Rr, x + w - Rr.w / 2, y, x + w - Rr.w / 2, y + h);
}
function setFont(g, cs) {
  g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  g.fillStyle = cs.color; g.strokeStyle = cs.color; g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g) g.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
}
function paintText(g, node) {
  const cs = getComputedStyle(node.parentElement);
  setFont(g, cs);
  const up = cs.textTransform === 'uppercase', ul = /underline/.test(cs.textDecorationLine || '');
  const text = node.textContent, range = document.createRange();
  let word = '', wx = 0, wy = 0, wr = 0;
  const flush = () => {
    if (!word) return;
    const s = up ? word.toUpperCase() : word;
    const m = g.measureText(s);
    const base = wy + (m.fontBoundingBoxAscent || parseFloat(cs.fontSize) * .8);
    g.fillText(s, wx, base);
    if (ul) { g.lineWidth = 1; g.beginPath(); g.moveTo(wx, base + 3.5); g.lineTo(wr, base + 3.5); g.stroke(); }
    word = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) { flush(); continue; }
    range.setStart(node, i); range.setEnd(node, i + 1);
    const rc = range.getClientRects()[0];
    if (!rc) continue;
    if (word && Math.abs(rc.top - wy) > 2) flush();
    if (!word) { wx = rc.left; wy = rc.top; }
    word += text[i]; wr = rc.right;
  }
  flush();
}
// An absolutely positioned ::before or ::after box (list bullets, for one).
function paintPseudo(g, el, which) {
  const ps = getComputedStyle(el, which);
  if (!ps.content || ps.content === 'none' || ps.display === 'none' || ps.position !== 'absolute') return;
  const w = parseFloat(ps.width), hh = parseFloat(ps.height);
  if (!(w > 0) || !(hh > 0)) return;
  const r = el.getBoundingClientRect();
  const left = parseFloat(ps.left), top = parseFloat(ps.top);
  const x = r.left + (isNaN(left) ? r.width - (parseFloat(ps.right) || 0) - w : left);
  const y = r.top + (isNaN(top) ? r.height - (parseFloat(ps.bottom) || 0) - hh : top);
  paintBox(g, x, y, w, hh, ps);
}
// The number of an ordered list item, right-aligned before its first line.
function paintMarker(g, li) {
  const ol = li.parentElement;
  const cs = getComputedStyle(li);
  if (!ol || ol.tagName !== 'OL' || cs.listStyleType === 'none') return;
  const idx = Array.prototype.indexOf.call(ol.children, li) + (Number(ol.getAttribute('start')) || 1);
  const first = (function find(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim()) return c;
      const d = c.nodeType === 1 && find(c);
      if (d) return d;
    }
    return null;
  })(li);
  const r = li.getBoundingClientRect();
  let top = r.top;
  if (first) {
    const at = first.textContent.search(/\S/);
    const range = document.createRange();
    range.setStart(first, at); range.setEnd(first, at + 1);
    const rc = range.getClientRects()[0];
    if (rc) top = rc.top;
  }
  setFont(g, cs);
  const mc = getComputedStyle(li, '::marker').color;
  if (visible(mc)) g.fillStyle = mc;
  const s = `${idx}.`;
  const m = g.measureText(s);
  const fs = parseFloat(cs.fontSize);
  g.fillText(s, r.left - m.width - fs * .35, top + (m.fontBoundingBoxAscent || fs * .8));
}

export async function paintSlide(sec) {
  const cv = document.createElement('canvas');
  cv.width = VW; cv.height = VH;
  const g = cv.getContext('2d');
  const bg = getComputedStyle(sec.parentElement).backgroundColor;
  g.fillStyle = visible(bg) ? bg : getComputedStyle(document.body).backgroundColor;
  g.fillRect(0, 0, VW, VH);
  const fr = getComputedStyle(sec, '::before');
  if (fr.content && fr.content !== 'none') {
    const t = parseFloat(fr.top) || 0, l = parseFloat(fr.left) || 0;
    paintBox(g, l, t, VW - l - (parseFloat(fr.right) || 0), VH - t - (parseFloat(fr.bottom) || 0), fr);
  }
  const walk = async n => {
    if (n.nodeType === 3) { if (n.textContent.trim()) paintText(g, n); return; }
    if (n.nodeType !== 1) return;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const tag = n.tagName.toLowerCase();
    if (tag === 'svg') {
      const { img, r } = await svgImage(n);
      if (!r.width || !r.height) return;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const m = new DOMMatrix(cs.transform === 'none' ? '' : cs.transform);
      g.save();
      g.translate(cx, cy); g.transform(m.a, m.b, m.c, m.d, m.e, m.f); g.translate(-cx, -cy);
      g.drawImage(img, r.left, r.top, r.width, r.height);
      g.restore();
      return;
    }
    const r = n.getBoundingClientRect();
    if (tag === 'img') {
      // Only same-origin and data: images; another origin's image would taint the canvas and stop the recording.
      let same = false;
      try { same = /^data:/.test(n.src) || new URL(n.currentSrc || n.src, location.href).origin === location.origin; } catch (_) { same = false; }
      if (same && n.complete && n.naturalWidth) g.drawImage(n, r.left, r.top, r.width, r.height);
      return;
    }
    paintBox(g, r.left, r.top, r.width, r.height, cs);
    paintPseudo(g, n, '::before');
    paintPseudo(g, n, '::after');
    if (tag === 'li') paintMarker(g, n);
    const clip = cs.overflow !== 'visible';
    if (clip) { g.save(); g.beginPath(); g.rect(r.left, r.top, r.width, r.height); g.clip(); }
    for (const c of n.childNodes) await walk(c);
    if (clip) g.restore();
  };
  for (const c of sec.childNodes) await walk(c);
  return cv;
}

// Lay copies of the slides out at 1920×1080, in their final state, and paint each one.
export async function paintAll(deck, onStep) {
  const box = h('div', { class: 'rec-layout still', 'aria-hidden': 'true' });
  box.inert = true;
  document.body.append(box);
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const out = [];
    const n = deck.model.slides.length;
    for (let i = 0; i < n; i++) {
      const s = deck.model.slides[i];
      const sec = buildSlide(s, i, deck.model.deck);
      sec.classList.add('active', 'on');
      box.append(sec);
      drawSlide(sec, deck.modFor(s), false, deck.icons);
      out.push(await paintSlide(sec));
      sec.remove();
      if (onStep) onStep(i + 1, n);
    }
    return out;
  } finally {
    box.remove();
  }
}

/* ---------- WebM duration ---------- */

// MediaRecorder writes WebM with no duration (Chrome) or a zero one (Firefox);
// set it in the Info element so players can seek.
export async function webmDuration(blob, ms) {
  const h8 = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
  const vlen = b => { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 9; };
  const id = q => { const l = vlen(h8[q]); let v = 0; for (let i = 0; i < l; i++) v = v * 256 + h8[q + i]; return [v, l]; };
  const size = q => { const l = vlen(h8[q]); let v = h8[q] & (0xFF >> l); for (let i = 1; i < l; i++) v = v * 256 + h8[q + i]; return [v, l]; };
  const [i0, l0] = id(0), [z0, s0] = size(l0);
  if (i0 !== 0x1A45DFA3) return blob;
  let q = l0 + s0 + z0;
  const [i1, l1] = id(q), [, s1] = size(q + l1);
  if (i1 !== 0x18538067) return blob;
  q += l1 + s1;
  while (q < h8.length - 16) {
    const [ci, cl] = id(q), [cz, cs] = size(q + cl);
    const body = q + cl + cs, end = body + cz;
    if (ci === 0x1F43B675 || end > h8.length) return blob;
    if (ci === 0x1549A966) {
      let scale = 1e6, dq = 0, dz = 0;
      for (let r = body; r < end;) {
        const [ei, el] = id(r), [ez, es] = size(r + el);
        if (ei === 0x4489) { dq = r + el + es; dz = ez; }
        if (ei === 0x2AD7B1) { scale = 0; for (let k = 0; k < ez; k++) scale = scale * 256 + h8[r + el + es + k]; }
        r += el + es + ez;
      }
      const ticks = ms * 1e6 / (scale || 1e6);
      if (dq) {
        const dv = new DataView(h8.buffer);
        if (dz === 8) dv.setFloat64(dq, ticks); else if (dz === 4) dv.setFloat32(dq, ticks); else return blob;
        return new Blob([h8.subarray(0, end), blob.slice(end)], { type: blob.type });
      }
      const nz = cz + 11;
      if (nz >= 2 ** (7 * cs) - 1) return blob;
      const hdr = new Uint8Array(cl + cs);
      hdr.set(h8.subarray(q, q + cl));
      for (let k = cs - 1, v = nz; k >= 0; k--, v = Math.floor(v / 256)) hdr[cl + k] = v & 0xFF;
      hdr[cl] |= 0x80 >> (cs - 1);
      const dur = new Uint8Array(11);
      dur.set([0x44, 0x89, 0x88]);
      new DataView(dur.buffer).setFloat64(3, ticks);
      return new Blob([h8.subarray(0, q), hdr, h8.subarray(body, end), dur, blob.slice(end)], { type: blob.type });
    }
    q = end;
  }
  return blob;
}

/* ---------- the recorder ---------- */

export function createRecorder(deck) {
  const root = document.documentElement;
  const model = deck.model;
  const limit = () => model.total || 0;
  const R = { state: 'idle' };
  const recBtn = document.getElementById('record-btn');

  const stateEl = h('span', { text: 'Recording' });
  const timeEl = h('span', { id: 'rp-time', text: '0:00' });
  const limEl = h('span', { class: 'rp-lim' });
  const curEl = h('p', { id: 'rp-cur' });
  const scriptEl = h('div', { id: 'rp-script' });
  const nextThumb = h('canvas', { class: 'rp-thumb', width: '192', height: '108', 'aria-hidden': 'true' });
  const nextEl = h('span');
  const pauseBtn = h('button', { type: 'button', id: 'rp-pause', text: 'Pause (P)' });
  const stopBtn = h('button', { type: 'button', id: 'rp-stop', text: 'Stop and save (R)' });
  const panel = h('aside', { id: 'rec-panel', hidden: true, 'aria-label': 'Presenter panel, not in the video' },
    h('p', { class: 'rp-top' }, h('span', { class: 'rp-dot' }), stateEl, timeEl, limEl),
    curEl, scriptEl,
    h('div', { class: 'rp-next' }, nextThumb, h('span', {}, 'Next: ', nextEl)),
    h('div', { class: 'rp-btns' }, pauseBtn, stopBtn),
    h('p', { class: 'rp-note', text: 'This panel is not in the video.' }));
  const countEl = h('div', { id: 'rec-count', hidden: true, 'aria-live': 'assertive' });
  const msg = h('div', { id: 'rec-msg', hidden: true, role: 'status' });
  document.body.append(panel, countEl, msg);

  function say(parts, kind) {
    msg.textContent = '';
    msg.append(...parts, h('button', { type: 'button', class: 'rm-x', 'aria-label': 'Close', text: '×', onclick: () => { msg.hidden = true; } }));
    msg.className = kind || '';
    msg.hidden = false;
  }
  const kbd = k => h('kbd', { text: k });

  function setState(st) {
    R.state = st;
    if (st === 'idle') delete root.dataset.recording; else root.dataset.recording = st;
    recBtn.setAttribute('aria-pressed', String(st !== 'idle'));
    recBtn.setAttribute('aria-label', st === 'idle' ? 'Record a video (R)' : 'Stop recording (R)');
    panel.hidden = !(st === 'recording' || st === 'paused');
    pauseBtn.textContent = st === 'paused' ? 'Resume (P)' : 'Pause (P)';
    stateEl.textContent = st === 'paused' ? 'Paused' : 'Recording';
    updatePanel();
  }
  const elapsed = () => (R.acc || 0) + (R.state === 'recording' && R.since ? (performance.now() - R.since) / 1000 : 0);
  function updatePanel() {
    if (panel.hidden) return;
    const t = elapsed();
    const lim = limit();
    timeEl.textContent = formatDuration(t);
    timeEl.classList.toggle('over', !!lim && t > lim);
    limEl.textContent = lim ? `/ ${formatDuration(lim)}` : '';
    const i = deck.cur, s = model.slides[i], nx = model.slides[i + 1];
    const onSlide = R.slideAt != null ? t - R.slideAt : 0;
    curEl.textContent = `Slide ${i + 1} of ${model.slides.length} · ${formatDuration(onSlide)}` + (s.duration != null ? ` of about ${formatDuration(s.duration)}` : '');
    if (R.scriptFor !== i) {
      scriptEl.textContent = '';
      s.notes.forEach(l => scriptEl.append(h('p', { text: l })));
      if (!s.notes.length) scriptEl.append(h('p', { class: 'rp-none', text: 'No script for this slide.' }));
      nextEl.textContent = nx ? nx.title : 'the end';
      const tg = nextThumb.getContext('2d');
      tg.clearRect(0, 0, 192, 108);
      nextThumb.hidden = !(nx && R.snaps && R.snaps[i + 1]);
      if (!nextThumb.hidden) tg.drawImage(R.snaps[i + 1], 0, 0, 192, 108);
      R.scriptFor = i;
    }
  }
  function frame(now) {
    if (!R.g) return;
    if (R.shown !== deck.cur) { R.from = R.shown; R.shown = deck.cur; R.t0 = now; R.slideAt = elapsed(); updatePanel(); }
    const a = R.from == null ? 1 : Math.min(1, (now - R.t0) / 350);
    const g = R.g;
    g.globalAlpha = 1;
    if (a < 1) g.drawImage(R.snaps[R.from], 0, 0);
    g.globalAlpha = a;
    g.drawImage(R.snaps[R.shown], 0, 0);
    g.globalAlpha = 1;
    R.raf = requestAnimationFrame(frame);
  }
  function release() {
    cancelAnimationFrame(R.raf);
    clearInterval(R.tick);
    if (R.mic) R.mic.getTracks().forEach(t => t.stop());
    if (R.stream) R.stream.getTracks().forEach(t => t.stop());
    Object.assign(R, { run: null, g: null, mic: null, stream: null, rec: null, snaps: null, shown: null, from: null, acc: 0, since: 0, slideAt: null, scriptFor: null });
    countEl.hidden = true;
    setState('idle');
  }

  async function start() {
    if (R.state !== 'idle') return;
    msg.hidden = true;
    const probe = document.createElement('canvas');
    if (!window.MediaRecorder || !probe.captureStream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say(['This browser cannot record the deck here. Recent Chrome, Edge, Firefox and Safari can.'], 'err');
      return;
    }
    setState('arming');
    const run = R.run = {};
    deck.toggleNotes(false);
    deck.toggleSources(false);
    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (R.run !== run) return;
      release();
      const blocked = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      say(blocked
        ? ['The microphone was blocked, so nothing was recorded. Allow the microphone for this page in the browser’s site settings, then press ', kbd('R'), ' again.']
        : [`No microphone could be opened (${(e && e.name) || 'error'}), so nothing was recorded. Connect one and press `, kbd('R'), ' again.'], 'err');
      return;
    }
    if (R.run !== run) { mic.getTracks().forEach(t => t.stop()); return; }
    R.mic = mic;
    countEl.hidden = false;
    countEl.textContent = 'Preparing slides…';
    let snaps;
    try {
      snaps = await paintAll(deck, (k, n) => { if (R.run === run) countEl.textContent = `Preparing slides ${k} / ${n}`; });
    } catch (e) {
      if (R.run !== run) return;
      release();
      say([`The slides could not be prepared for recording (${(e && e.message) || 'error'}). Nothing was recorded.`], 'err');
      return;
    }
    if (R.run !== run) return;
    R.snaps = snaps;
    const cv = document.createElement('canvas');
    cv.width = VW; cv.height = VH;
    R.g = cv.getContext('2d');
    R.shown = null; R.from = null;
    R.raf = requestAnimationFrame(frame);
    R.stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...R.mic.getAudioTracks()]);
    R.mime = pickMime();
    setState('counting');
    for (const k of [3, 2, 1]) {
      countEl.textContent = '';
      countEl.append(h('b', { text: String(k) }), h('span', { text: 'Recording starts. Press R or Escape to cancel.' }));
      await new Promise(r => setTimeout(r, 1000));
      if (R.run !== run) return;
    }
    countEl.hidden = true;
    const chunks = [];
    const rec = new MediaRecorder(R.stream, { mimeType: R.mime || undefined, videoBitsPerSecond: 8e6, audioBitsPerSecond: 128e3 });
    R.rec = rec;
    rec.addEventListener('dataavailable', e => { if (e.data && e.data.size) chunks.push(e.data); });
    rec.addEventListener('stop', () => save(chunks, rec.mimeType || R.mime, elapsed()));
    R.acc = 0; R.since = performance.now(); R.slideAt = 0; R.from = null; R.shown = deck.cur;
    rec.start(1000);
    setState('recording');
    R.tick = setInterval(updatePanel, 250);
  }
  function pause() {
    if (R.state === 'recording') { R.acc = elapsed(); R.since = 0; R.rec.pause(); setState('paused'); }
    else if (R.state === 'paused') { R.since = performance.now(); R.rec.resume(); setState('recording'); }
  }
  function stop() {
    if (R.state === 'arming' || R.state === 'counting') { release(); say(['Recording cancelled; nothing was saved.']); return; }
    if (R.state !== 'recording' && R.state !== 'paused') return;
    R.acc = elapsed(); R.since = 0;
    R.rec.stop();
  }
  async function save(chunks, mime, secs) {
    release();
    const type = (mime || 'video/webm').split(';')[0];
    let blob = new Blob(chunks, { type });
    if (/webm/.test(type)) try { blob = await webmDuration(blob, secs * 1000); } catch (_) { /* keep the file as recorded */ }
    const ext = /mp4/.test(type) ? 'mp4' : 'webm';
    const fmt = formatLabel(mime);
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `${deck.slug}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`;
    if (R.url) URL.revokeObjectURL(R.url);
    R.url = URL.createObjectURL(blob);
    const a = h('a', { href: R.url, download: name });
    document.body.append(a); a.click(); a.remove();
    say(['Saved ', h('b', { text: name }), `: ${fmt}, 1920×1080, ${formatDuration(secs)}, ${(blob.size / 1048576).toFixed(1)} MB. It stays on this computer; nothing was uploaded. `, h('a', { href: R.url, download: name, text: 'Download again' })], 'ok');
    dispatchEvent(new CustomEvent('seal-slides:recording', { detail: { filename: name, type: blob.type, size: blob.size, seconds: secs, width: VW, height: VH } }));
  }
  [[pauseBtn, pause], [stopBtn, stop]].forEach(([b, fn]) => b.addEventListener('click', () => { b.blur(); fn(); }));
  deck.on('slide', () => { if (!panel.hidden) updatePanel(); });

  return { toggle: () => (R.state === 'idle' ? start() : stop()), start, stop, pause, get state() { return R.state; } };
}
