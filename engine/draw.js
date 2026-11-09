// The SVG drawing vocabulary: the drawing context animated slides draw with,
// the icon set, the seals, and a small timeline helper for played slides.
// Every mark is styled by class (see seal-slides.css), so the same drawing
// follows the light and dark themes, and each mark carries its own entrance
// delay (--d) so a slide prints itself once when it arrives.

export const NS = 'http://www.w3.org/2000/svg';
export const deg = Math.PI / 180;
export const f2 = n => Math.round(n * 100) / 100;

export function E(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

// Wrap a sentence into lines of at most n characters.
export function wrap(s, n) {
  const out = [];
  let cur = '';
  String(s).split(' ').forEach(x => {
    if ((cur + ' ' + x).trim().length > n && cur) { out.push(cur); cur = x; } else cur = cur ? cur + ' ' + x : x;
  });
  if (cur) out.push(cur);
  return out;
}

/* ---------- seals: a guilloché rosette drawn from a digest's 32 bytes ---------- */

const bytesOf = h => Array.from({ length: 32 }, (_, i) => parseInt(h.substr(i * 2, 2), 16));

// Adds <symbol id="seal-NAME"> (dense) and "seal-NAME-mini" (fewer lines, for
// small sizes) to a <defs> element.
export function buildSeal(defs, name, hex) {
  [['', true], ['-mini', false]].forEach(([suffix, dense]) => {
    const sym = E('symbol', { id: `seal-${name}${suffix}`, viewBox: '-100 -100 200 200', overflow: 'visible' }, defs);
    const b = bytesOf(hex);
    let d = '';
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * Math.PI * 2 - Math.PI / 2;
      const r1 = 86, r2 = 90 + 10 * b[i] / 255;
      d += `M${f2(r1 * Math.cos(a))} ${f2(r1 * Math.sin(a))}L${f2(r2 * Math.cos(a))} ${f2(r2 * Math.sin(a))}`;
    }
    E('path', { d, class: 's-tick' }, sym);
    E('circle', { r: 83, class: 's-ring' }, sym);
    E('circle', { r: 6, class: 's-ring' }, sym);
    const bands = dense ? [[30, 0], [50, 10], [68, 20]] : [[38, 0], [64, 12]];
    const copies = dense ? 11 : 6, N = dense ? 520 : 300;
    bands.forEach(([r0, o]) => {
      const amp = 4.5 + 9 * b[o] / 255;
      const k = 3 + (b[o + 1] % 9) + Math.round(r0 / 22);
      const m = 1 + (b[o + 2] % 5);
      const mod = .1 + .6 * b[o + 3] / 255;
      const ph = b[o + 4] / 255 * Math.PI * 2;
      for (let c = 0; c < copies; c++) {
        const sh = c / copies * Math.PI * 2;
        let p = '';
        for (let i = 0; i <= N; i++) {
          const t = i / N * Math.PI * 2;
          const r = r0 + amp * Math.sin(k * t + sh) * (1 + mod * Math.sin(m * t + ph));
          p += (i ? 'L' : 'M') + f2(r * Math.cos(t)) + ' ' + f2(r * Math.sin(t));
        }
        E('path', { d: p + 'Z', class: 's-wave' }, sym);
      }
    });
  });
}

/* ---------- icons, in a 60-unit box centred on 0,0 ---------- */

const scallop = (() => {
  let d = '';
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2, am = (i - .5) / n * Math.PI * 2;
    const x = 19 * Math.cos(a), y = 19 * Math.sin(a);
    if (i === 0) d += `M${f2(x)} ${f2(y)}`;
    else d += `Q${f2(25 * Math.cos(am))} ${f2(25 * Math.sin(am))} ${f2(x)} ${f2(y)}`;
  }
  return d + 'Z';
})();

// Each icon is a list of [tag, attributes]. A circle with r < 3 is filled as a dot.
export const ICONS = {
  key: [['circle', { cx: -14, cy: 0, r: 9 }], ['path', { d: 'M-5 0H26M18 0V8M24 0V6' }]],
  person: [['circle', { cx: 0, cy: -10, r: 9 }], ['path', { d: 'M-18 22C-18 5 18 5 18 22' }]],
  passkey: [['circle', { cx: -9, cy: -11, r: 7.5 }], ['path', { d: 'M-24 18C-24 4 6 4 6 18' }], ['circle', { cx: 13, cy: -2, r: 5.5 }], ['path', { d: 'M13 3.5V22M13 16H18M13 11H17' }]],
  secret: [['path', { d: 'M0 -22L20 0L0 22L-20 0Z' }], ['path', { d: 'M0 -9L8 0L0 9L-8 0Z' }]],
  envelope: [['rect', { x: -24, y: -16, width: 48, height: 32, rx: 3 }], ['path', { d: 'M-24 -14L0 4L24 -14' }]],
  tree: [['path', { d: 'M0 -18L-13 -2M0 -18L13 -2M-13 -2L-20 16M-13 -2L-6 16M13 -2L6 16M13 -2L20 16' }]],
  account: [['circle', { r: 22 }], ['circle', { r: 12 }]],
  controller: [['rect', { x: -26, y: -18, width: 52, height: 36, rx: 6 }], ['path', { d: 'M-12 9A12 12 0 0 1 12 9M0 9L7 -2' }]],
  stamp: [['path', { d: scallop }], ['circle', { r: 10 }]],
  hourglass: [['path', { d: 'M-11 -20H11L-11 20H11Z' }]],
  sig: [['path', { d: 'M-25 6C-17 -14 -10 18 -2 0S10 -12 14 4S22 8 26 -4' }]],
  proof: [['path', { d: 'M0 -22L19 -11V11L0 22L-19 11V-11ZM0 0V22M0 0L19 -11M0 0L-19 -11' }]],
  check: [['path', { d: 'M-14 1L-4 12L16 -12' }]],
  cross: [['path', { d: 'M-12 -12L12 12M12 -12L-12 12' }]],
  agent: [['rect', { x: -17, y: -20, width: 34, height: 26, rx: 8 }], ['path', { d: 'M0 -20V-26M-21 26V22C-21 15 21 15 21 22V26M-8 -1H8' }], ['circle', { cx: -7, cy: -10, r: 2.6 }], ['circle', { cx: 7, cy: -10, r: 2.6 }], ['circle', { cx: 0, cy: -28, r: 2.4 }]],
  shop: [['path', { d: 'M-24 -8H24L20 -22H-20ZM-20 -8V22H20V-8M-6 22V8H6V22M-24 -8C-24 -2 -12 -2 -12 -8C-12 -2 0 -2 0 -8C0 -2 12 -2 12 -8C12 -2 24 -2 24 -8' }]],
  cup: [['path', { d: 'M-20 -8H14V8C14 18 6 22 -3 22C-12 22 -20 18 -20 8ZM14 -2C24 -2 24 12 14 12M-10 -16C-6 -20 -12 -22 -8 -27M1 -16C5 -20 -1 -22 3 -27' }]],
  doc: [['path', { d: 'M-16 -24H8L18 -14V24H-16ZM8 -24V-14H18M-8 -4H10M-8 4H10M-8 12H4' }]],
  coin: [['circle', { r: 21 }], ['circle', { r: 14 }]],
  warn: [['path', { d: 'M0 -20L22 17H-22ZM0 -6V5' }], ['circle', { cx: 0, cy: 11, r: 1.6 }]],
  policy: [['rect', { x: -20, y: -22, width: 40, height: 44, rx: 8 }], ['path', { d: 'M-10 -8H10M-10 0H10M-10 8H4' }]],
  door: [['rect', { x: -15, y: -26, width: 30, height: 52, rx: 2 }], ['circle', { cx: 8, cy: 2, r: 2.5 }]],
  factory: [['path', { d: 'M-27 24V-2L-11 8V-2L5 8V-18H17V24ZM-19 14H-11M-3 14H5' }]],
  desk: [['circle', { cx: 0, cy: -15, r: 8 }], ['path', { d: 'M-15 4C-15 -5 15 -5 15 4M-28 4H28V24H-28ZM-28 10H28' }]],
  mic: [['rect', { x: -8, y: -24, width: 16, height: 28, rx: 8 }], ['path', { d: 'M-16 -4C-16 18 16 18 16 -4M0 14V24M-9 24H9' }]],
  pencil: [['path', { d: 'M-20 20L-16 6L10 -20L20 -10L-6 16ZM4 -14L14 -4M-20 20L-6 16' }]],
  comment: [['path', { d: 'M-24 -18H24V12H-4L-16 22V12H-24Z' }], ['path', { d: 'M-14 -6H14M-14 2H6' }]],
  branch: [['circle', { cx: -10, cy: -18, r: 5 }], ['circle', { cx: -10, cy: 18, r: 5 }], ['circle', { cx: 12, cy: -8, r: 5 }], ['path', { d: 'M-10 -13V13M12 -3C12 8 -10 4 -10 13' }]],
};
const TREE_DOTS = [[0, -18], [-13, -2], [13, -2], [-20, 16], [-6, 16], [6, 16], [20, 16]];

/* ---------- drawing context ---------- */

// One Ctx draws one slide at one orientation. `tall` is true in portrait.
// Every drawing call takes an options object; the common keys are
//   k     stroke colour: ink, soft, faint, now, next, seal, paper
//   w     stroke width as a multiple of the base width (or raw with raw: true)
//   fill  fill: now, next, ink, soft, seal, paper, paper2, hatch, hatch-now
//   d     entrance delay in ms (otherwise the running clock, advanced by step)
//   anim  an-draw, an-fade, an-march, an-seal, an-sweep or none
//   p     parent element (defaults to the current layer)
export class Ctx {
  constructor(svg, tall, icons = ICONS) {
    this.svg = svg; this.tall = tall; this.layer = svg;
    this.icons = icons;
    this.t = 150; this.step = 60;
    this.fs = tall ? 36 : 27;
    this.sw = tall ? 3.4 : 2.4;
    this.E = E; this.f2 = f2; this.deg = deg; this.wrap = wrap;
  }
  at(ms) { this.t = ms; return this; }
  group(tf) { this.layer = E('g', tf ? { transform: tf } : null, this.svg); return this.layer; }
  _d(o) {
    if (o && o.d != null) return o.d;
    const d = this.t;
    this.t += (o && o.step != null) ? o.step : this.step;
    return d;
  }
  _paint(e, o, d) {
    const k = o.k || 'ink';
    const cls = ['st', 'k-' + k];
    let anim = k === 'next' ? 'an-march' : 'an-draw';
    if (o.fill) { cls.push('fl-' + o.fill); anim = k === 'next' ? 'an-march' : 'an-fade'; }
    if (o.anim) anim = o.anim;
    if (anim !== 'none') cls.push(anim);
    if (o.cls) cls.push(o.cls);
    e.setAttribute('class', cls.join(' '));
    e.setAttribute('stroke-width', o.w != null ? o.w * (o.raw ? 1 : this.sw) : this.sw);
    if (o.fillOp != null) e.setAttribute('fill-opacity', o.fillOp);
    if (o.op != null) e.setAttribute('opacity', o.op);
    if (o.dash) e.setAttribute('stroke-dasharray', o.dash);
    e.style.setProperty('--d', d + 'ms');
    return e;
  }
  line(x1, y1, x2, y2, o = {}) { return this._paint(E('line', { x1, y1, x2, y2 }, o.p || this.layer), o, this._d(o)); }
  path(d, o = {}) { return this._paint(E('path', { d }, o.p || this.layer), o, this._d(o)); }
  circle(cx, cy, r, o = {}) { return this._paint(E('circle', { cx, cy, r }, o.p || this.layer), o, this._d(o)); }
  rect(x, y, w, h, o = {}) { return this._paint(E('rect', { x, y, width: w, height: h, rx: o.rx || 0 }, o.p || this.layer), o, this._d(o)); }
  text(x, y, s, o = {}) {
    const size = this.fs * (o.size || 1);
    const t = E('text', { x, y, 'font-size': f2(size), 'text-anchor': o.anchor || 'middle' }, o.p || this.layer);
    if (o.base) t.setAttribute('dominant-baseline', o.base);
    const cls = ['tx'];
    if (o.anim !== 'none') cls.push(o.anim || 'an-fade');
    if (o.k) cls.push('c-' + o.k);
    if (o.font) cls.push('f-' + o.font);
    t.setAttribute('class', cls.join(' '));
    if (o.ls != null) t.setAttribute('letter-spacing', o.ls);
    if (o.italic) t.setAttribute('font-style', 'italic');
    t.textContent = s;
    t.style.setProperty('--d', this._d(o) + 'ms');
    return t;
  }
  // Several lines of text, one under the other, starting at y.
  lines(x, y, list, o = {}) {
    const lh = this.fs * (o.size || 1) * (o.lh || 1.3);
    const d = this._d(o);
    return list.map((s, i) => this.text(x, y + i * lh, s, { ...o, d: d + i * 80 }));
  }
  // Approximate text width, enough to size chips and boxes.
  tw(s, o = {}) { return s.length * this.fs * (o.size || 1) * (o.font === 'code' ? .6 : .52); }
  chip(x, y, s, o = {}) {
    const size = (o.size || .85);
    const w = this.tw(s, { size, font: o.font }) + this.fs * .9, h = this.fs * size * 1.7;
    const d = this._d(o);
    this.rect(x - w / 2, y - h / 2, w, h, { k: o.k || 'soft', rx: h / 2, w: o.w || .55, d, fill: o.fill, fillOp: o.fillOp, p: o.p });
    this.text(x, y + 1, s, { size, k: o.tk, font: o.font, base: 'central', d: d + 120, p: o.p });
    return w;
  }
  // A seal from the deck's seals (o.id, default A). Small seals use the mini symbol.
  seal(x, y, r, o = {}) {
    const id = 'seal-' + (o.id || 'A') + (r * (this.tall ? .45 : .85) < 60 ? '-mini' : '');
    const d = this._d(o);
    if (o.bg) this._paint(E('circle', { cx: x, cy: y, r: r * 1.04 }, o.p || this.layer), { k: 'faint', fill: 'paper', w: .4, anim: 'an-fade' }, d);
    const at = E('g', { transform: `translate(${f2(x)} ${f2(y)})` }, o.p || this.layer);
    const g = E('g', null, at);
    g.setAttribute('class', 'seal-use an-seal');
    g.style.setProperty('--d', d + 'ms');
    E('use', { href: '#' + id, x: -r, y: -r, width: 2 * r, height: 2 * r }, g);
    return at;
  }
  icon(name, x, y, s, o = {}) {
    const sc = s / 60;
    const g = E('g', { transform: `translate(${x} ${y}) scale(${f2(sc)})` }, o.p || this.layer);
    const d = this._d(o);
    const k = o.k || 'ink';
    const ik = k === 'next' ? 'nexthead' : k;
    const parts = this.icons[name];
    if (!parts) throw new Error(`unknown icon "${name}"`);
    parts.forEach(([tag, a]) => {
      const e = E(tag, a, g);
      const small = tag === 'circle' && a.r != null && a.r < 3;
      const dot = { next: 'next', soft: 'soft', now: 'now', seal: 'seal' }[k] || 'ink';
      this._paint(e, { k: ik, w: this.sw / sc * (o.w || 1), raw: true, fill: small ? dot : o.fill, anim: o.anim || (k === 'next' ? 'an-fade' : null) }, d);
    });
    if (name === 'tree') TREE_DOTS.forEach(([cx, cy]) => {
      this._paint(E('circle', { cx, cy, r: 3 }, g), { k: ik, fill: k === 'next' ? 'next' : (k === 'now' ? 'now' : 'soft'), w: this.sw / sc, raw: true, anim: 'an-fade' }, d);
    });
    return g;
  }
  head(x, y, ang, o = {}) {
    const L = this.tall ? 17 : 13;
    const a1 = ang + Math.PI - .45, a2 = ang + Math.PI + .45;
    return this.path(`M${f2(x + L * Math.cos(a1))} ${f2(y + L * Math.sin(a1))}L${f2(x)} ${f2(y)}L${f2(x + L * Math.cos(a2))} ${f2(y + L * Math.sin(a2))}`, { ...o, k: o.k === 'next' ? 'nexthead' : o.k, anim: 'an-fade' });
  }
  arrow(x1, y1, x2, y2, o = {}) {
    const d = this._d(o);
    this.line(x1, y1, x2, y2, { ...o, d });
    this.head(x2, y2, Math.atan2(y2 - y1, x2 - x1), { ...o, d: d + 500 });
  }
  curve(x1, y1, x2, y2, o = {}) {
    const dir = o.dir || 'h';
    let c1, c2;
    if (dir === 'h') { const mx = (x1 + x2) / 2; c1 = [mx, y1]; c2 = [mx, y2]; }
    else { const my = (y1 + y2) / 2; c1 = [x1, my]; c2 = [x2, my]; }
    const d = this._d(o);
    const p = this.path(`M${f2(x1)} ${f2(y1)}C${f2(c1[0])} ${f2(c1[1])} ${f2(c2[0])} ${f2(c2[1])} ${f2(x2)} ${f2(y2)}`, { ...o, d });
    if (o.head) this.head(x2, y2, Math.atan2(y2 - c2[1], x2 - c2[0]), { ...o, d: d + 600 });
    return p;
  }
  check(x, y, s, o = {}) { return this.icon('check', x, y, s, { ...o, w: 1.5 }); }
  cross(x, y, s, o = {}) { return this.icon('cross', x, y, s, { ...o, w: 1.4 }); }
  node(x, y, r, s, o = {}) {
    const d = this._d(o);
    this.circle(x, y, r, { k: o.k || 'now', d, w: o.w });
    if (s) this.text(x, y, s, { size: o.size || .72, k: o.tk || o.k, base: 'central', d: d + 150 });
  }
  pin(x, y, o = {}) { return this.circle(x, y, this.tall ? 9 : 7, { k: o.k || 'now', fill: o.k === 'next' ? 'next' : (o.k === 'soft' ? 'soft' : 'now'), w: .4, d: o.d }); }
  region(x, y, w, h, o = {}) {
    const d = this._d(o);
    this.rect(x, y, w, h, { k: 'soft', fill: 'hatch', rx: 28, w: .5, d, anim: 'an-fade' });
    if (o.label) this.text(x + 4, y - (this.tall ? 18 : 14), o.label, { anchor: 'start', size: .8, k: 'soft', d });
  }
  // A box with a double border, a single border or a hatched fill.
  box(x, y, w, h, kind = 'single', o = {}) {
    const d = this._d(o);
    const k = o.k || 'now';
    if (kind === 'double') {
      this.rect(x - 7, y - 7, w + 14, h + 14, { k, rx: (o.rx || 16) + 6, w: 1.25, d });
      this.rect(x, y, w, h, { k, rx: o.rx || 16, w: .5, d: d + 80 });
    } else if (kind === 'hatched') {
      this.rect(x, y, w, h, { k, rx: o.rx || 16, w: .8, fill: 'hatch', d });
    } else {
      this.rect(x, y, w, h, { k, rx: o.rx || 16, w: .9, d });
    }
  }
  // A binary tree of `levels` levels with the path to leaf `hi` lit.
  btree(x, y, w, levels, dy, hi, o = {}) {
    const d = this._d(o);
    const pos = [];
    for (let l = 0; l <= levels; l++) {
      const n = 2 ** l, row = [];
      for (let i = 0; i < n; i++) row.push([x - w / 2 + (i + .5) * w / n, y + l * dy]);
      pos.push(row);
    }
    let path = hi;
    const onPath = new Set();
    for (let l = levels; l >= 0; l--) { onPath.add(l + ':' + path); path = path >> 1; }
    const hk = o.hk || 'now';
    for (let l = 0; l < levels; l++) pos[l].forEach(([px, py], i) => {
      [2 * i, 2 * i + 1].forEach(j => {
        const [cx, cy] = pos[l + 1][j];
        const lit = onPath.has(l + ':' + i) && onPath.has((l + 1) + ':' + j);
        this.line(px, py, cx, cy, { k: lit ? hk : (o.k || 'soft'), w: lit ? 1.1 : .5, d: d + (lit ? 300 + l * 120 : l * 60), anim: lit && hk === 'next' ? 'an-fade' : null });
      });
    });
    pos[levels].forEach(([px, py], i) => {
      const lit = i === hi;
      this.circle(px, py, lit ? (this.tall ? 8 : 6.5) : (this.tall ? 4.5 : 3.5), { k: lit ? (hk === 'next' ? 'nexthead' : hk) : (o.k || 'soft'), fill: lit ? (hk === 'next' ? 'next' : 'now') : 'paper', w: .5, d: d + (lit ? 700 : 200) });
    });
    return pos;
  }
}

/* ---------- a small timeline for slides that play ---------- */

export class Anim {
  constructor() { this.timers = []; this.alive = true; }
  at(ms, fn) { this.timers.push(setTimeout(() => { if (this.alive) fn(); }, ms)); }
  tween(dur, fn) {
    const t0 = performance.now();
    const ease = p => p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const step = now => {
      if (!this.alive) return;
      const p = Math.min(1, (now - t0) / dur);
      fn(ease(p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  stop() { this.alive = false; this.timers.forEach(clearTimeout); this.timers = []; }
}
