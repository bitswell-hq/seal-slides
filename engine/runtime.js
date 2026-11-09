// The deck runtime: builds the slides from the loaded model, draws the
// animated ones, and runs navigation, themes, speaker notes and the sources
// view. The editor and the recorder drive it through the object mountDeck
// returns.

import { renderMarkdown, renderInline, formatDuration } from './loader.js';
import { E, Ctx, ICONS, Anim, buildSeal } from './draw.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};
export { h };

const ICON = {
  prev: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  notes: '<path d="M5 5h14v10H9l-4 4z"/><path d="M8.5 9h7M8.5 12h4.5"/>',
  sources: '<path d="M6 4h9l3 3v13H6z"/><path d="M9 10h6M9 13h6M9 16h4"/>',
  theme: '<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 0 0 0 15z" fill="currentColor"/>',
  edit: '<path d="M5 19l1.2-4.2L15.5 5.5l3 3-9.3 9.3zM13.5 7.5l3 3"/>',
  comment: '<path d="M4 5h16v11H10l-4 3.5V16H4z"/>',
  record: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
export const icon = name => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[name];
  return s;
};
const btn = (id, label, name, extra = {}) => h('button', { class: 'btn', id, type: 'button', 'aria-label': label, title: label, ...extra }, icon(name));

const CHIP_SVG = {
  now: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg>',
  cited: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>',
};
const LEGEND_SVG = {
  now: '<svg viewBox="0 0 54 16" aria-hidden="true"><line x1="2" y1="8" x2="38" y2="8"/><circle cx="46" cy="8" r="5"/></svg>',
  next: '<svg viewBox="0 0 54 16" aria-hidden="true"><line x1="2" y1="8" x2="38" y2="8"/><circle cx="46" cy="8" r="5.5"/></svg>',
  cited: '<svg viewBox="0 0 54 16" aria-hidden="true"><line x1="2" y1="8" x2="38" y2="8"/><circle cx="46" cy="8" r="5"/></svg>',
};

function proofMarks() {
  const pm = h('div', { class: 'proofmarks', 'aria-hidden': 'true' });
  const crop = '<line x1="0" y1="14" x2="10" y2="14"/><line x1="14" y1="0" x2="14" y2="10"/>';
  const reg = '<circle cx="17" cy="17" r="6"/><line x1="17" y1="4" x2="17" y2="30"/><line x1="4" y1="17" x2="30" y2="17"/>';
  pm.innerHTML = ['tl', 'tr', 'bl', 'br'].map(p => `<svg class="${p}" viewBox="0 0 34 34">${crop}</svg>`).join('') +
    ['rl', 'rr'].map(p => `<svg class="${p}" viewBox="0 0 34 34">${reg}</svg>`).join('');
  return pm;
}

function mdBlock(s, extraClass) {
  const div = h('div', { class: 'md' + (extraClass ? ' ' + extraClass : '') });
  div.innerHTML = renderMarkdown(s.body, s.bodyStartLine);
  Array.from(div.children).forEach((c, i) => c.style.setProperty('--i', String(i)));
  return div;
}

// One slide's <section>. The drawing itself is added by drawSlide.
export function buildSlide(s, i, deckModel) {
  const status = s.status;
  const sec = h('section', {
    class: `slide layout-${s.layout}${s.draw ? '' : ' no-draw'}`,
    'data-status': status, 'data-index': String(i), 'data-file': s.file,
    'aria-roledescription': 'slide', 'aria-label': s.title,
  });
  const label = deckModel.statuses[status];
  const chip = label && CHIP_SVG[status] ? h('span', { class: 'status ' + status }) : null;
  if (chip) { chip.innerHTML = CHIP_SVG[status]; chip.append(label); }
  const hasBody = s.body.trim() !== '';
  const drawing = s.draw ? E('svg', { role: 'img', 'aria-label': s.alt }) : null;
  if (s.layout === 'title') {
    const text = h('div', { class: 'title-text' },
      s.kicker ? h('p', { class: 'kicker', 'data-line': s.lines.kicker, text: s.kicker }) : null,
      h('h1', { 'data-line': s.lines.title, text: s.title }),
      chip,
      hasBody ? mdBlock(s) : null);
    if (s.legend) {
      const ul = h('ul', { class: 'legend' });
      for (const k of ['now', 'next', 'cited']) {
        if (!deckModel.statuses[k]) continue;
        const li = h('li', { class: 'lg-' + k });
        li.innerHTML = LEGEND_SVG[k];
        li.append(deckModel.statuses[k]);
        ul.append(li);
      }
      text.append(ul);
    }
    sec.append(text);
    if (drawing) sec.append(h('div', { class: 'stage' }, drawing));
  } else {
    sec.append(h('header', { class: 'head' }, h('h2', { 'data-line': s.lines.title, text: s.title }), chip));
    if (drawing) sec.append(h('div', { class: 'stage' + (hasBody ? ' with-caption' : '') }, drawing, hasBody ? mdBlock(s) : null));
    else sec.append(h('div', { class: 'stage text' }, mdBlock(s)));
  }
  if (status === 'next') sec.prepend(proofMarks());
  return sec;
}

// Draw an animated slide into its <svg> for one orientation.
export function drawSlide(sec, mod, tall, icons) {
  const svg = $('.stage > svg', sec);
  if (!svg || !mod) return;
  while (svg.lastChild) svg.removeChild(svg.lastChild);
  const stage = svg.parentNode;
  $$('.draw-error', stage).forEach(e => e.remove());
  if (mod.error) {
    stage.prepend(h('p', { class: 'draw-error', text: `Drawing failed to load: ${mod.error}` }));
    return;
  }
  const vb = mod.viewBox || ['0 0 1600 800', '0 0 800 1300'];
  svg.setAttribute('viewBox', Array.isArray(vb) ? vb[tall ? 1 : 0] || vb[0] : vb);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  try {
    mod.draw(new Ctx(svg, tall, icons));
  } catch (e) {
    while (svg.lastChild) svg.removeChild(svg.lastChild);
    stage.prepend(h('p', { class: 'draw-error', text: `Drawing failed: ${e && e.message}` }));
    console.error(e);
    return;
  }
  $$('.an-draw', svg).forEach(e => {
    try { e.style.setProperty('--len', Math.ceil(e.getTotalLength()) + 1); } catch (_) { /* not a geometry element */ }
  });
}

// Import an animated slide's module. `url` is resolved against the deck page.
export async function loadDrawModule(url) {
  try {
    const m = await import(url);
    const mod = m.default || m;
    if (typeof mod.draw !== 'function') throw new Error('the module has no draw(c) function in its default export');
    return mod;
  } catch (e) {
    console.error(`seal-slides: ${url}:`, e);
    return { error: e && e.message ? e.message : String(e) };
  }
}

// The spoken script: one paragraph per line read aloud.
export function scriptBlock(lines) {
  const div = h('div', { class: 'script' });
  lines.forEach(l => { const p = h('p'); p.innerHTML = renderInline(l); div.append(p); });
  return div;
}

export async function mountDeck({ data, model, slug }) {
  const root = document.documentElement;
  const deckModel = model.deck;
  const listeners = {};
  const emit = (ev, arg) => (listeners[ev] || []).forEach(fn => fn(arg));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => reduce.matches || root.classList.contains('still');
  const qs = new URLSearchParams(location.search);
  const themeKey = `seal-slides:${slug}:theme`;

  root.lang = deckModel.lang || 'en';
  document.title = deckModel.title || document.title;

  /* theme */
  const darkQ = matchMedia('(prefers-color-scheme: dark)');
  if (deckModel.theme !== 'auto') root.dataset.theme = deckModel.theme;
  try { const t = localStorage.getItem(themeKey); if (t === 'light' || t === 'dark') root.dataset.theme = t; } catch (_) { /* storage unavailable */ }
  const qp = qs.get('theme');
  if (qp === 'light' || qp === 'dark') root.dataset.theme = qp;
  if (qs.get('still') === '1') root.classList.add('still');
  const isDark = () => { const t = root.dataset.theme; return t ? t === 'dark' : darkQ.matches; };

  /* defs: hatching and the deck's seals */
  const defsSvg = E('svg', { id: 'defs', width: 0, height: 0, style: 'position:absolute', 'aria-hidden': 'true', focusable: 'false' });
  const defs = E('defs', null, defsSvg);
  defs.innerHTML = '<pattern id="hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hl" x1="0" y1="0" x2="0" y2="9"/></pattern>' +
    '<pattern id="hatch-now" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hl-now" x1="0" y1="0" x2="0" y2="8"/></pattern>';
  for (const [name, hex] of Object.entries(deckModel.seals)) buildSeal(defs, name, hex);
  document.body.append(defsSvg);

  /* animated slide modules */
  const icons = { ...ICONS };
  const mods = new Map();
  const modFor = s => (s.draw ? mods.get(s.draw) : null);
  await Promise.all([...new Set(model.slides.filter(s => s.draw).map(s => s.draw))].map(async p => {
    const mod = await loadDrawModule(new URL(p, location.href).href);
    if (mod.icons) Object.assign(icons, mod.icons);
    mods.set(p, mod);
  }));

  /* slides */
  const deckEl = h('main', { id: 'deck', 'aria-roledescription': 'slide deck', 'aria-label': deckModel.title || 'Slides' });
  let slides = model.slides.map((s, i) => buildSlide(s, i, deckModel));
  deckEl.append(...slides);
  document.body.append(deckEl);

  const notesPanel = h('aside', { id: 'notes-panel', hidden: true, 'aria-label': 'Speaker script' });
  const sourcesPanel = h('aside', { id: 'sources-panel', hidden: true, 'aria-label': 'Sources for this slide' });
  const sourcesView = h('section', { id: 'sources-view', hidden: true, 'aria-label': 'All sources', tabindex: '-1' });
  document.body.append(notesPanel, sourcesPanel, sourcesView);

  const marks = h('ol', { class: 'marks', id: 'marks' });
  const count = h('span', { class: 'count', id: 'count', 'aria-live': 'polite' });
  const commentsBtn = btn('comments-btn', 'Comments', 'comment', { hidden: true });
  const commentBadge = h('span', { class: 'badge' });
  commentsBtn.append(commentBadge);
  const chrome = h('nav', { class: 'chrome', 'aria-label': 'Deck controls' },
    btn('prev', 'Previous slide', 'prev'),
    marks, count,
    btn('notes-btn', 'Speaker script (N)', 'notes', { 'aria-pressed': 'false' }),
    btn('sources-btn', 'Sources (S)', 'sources', { 'aria-pressed': 'false' }),
    commentsBtn,
    btn('edit-btn', 'Edit (E)', 'edit', { 'aria-pressed': 'false' }),
    btn('record-btn', 'Record a video (R)', 'record', { 'aria-pressed': 'false' }),
    btn('theme-btn', 'Switch theme (T)', 'theme'),
    btn('next', 'Next slide', 'next'),
    h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { id: 'bar' })));
  document.body.append(chrome);
  const syncThemeLabel = () => $('#theme-btn').setAttribute('aria-label', isDark() ? 'Switch to light theme (T)' : 'Switch to dark theme (T)');
  syncThemeLabel();

  let cur = 0, tallMode = null;
  const leaveTimers = new Map();
  const svgOf = s => $('.stage > svg', s);
  const enter = i => { const m = modFor(model.slides[i]); const svg = svgOf(slides[i]); if (m && m.enter && svg) try { m.enter(svg, { still: still(), Anim }); } catch (e) { console.error(e); } };
  const leave = i => { const m = modFor(model.slides[i]); const svg = svgOf(slides[i]); if (m && m.leave && svg) try { m.leave(svg); } catch (e) { console.error(e); } };

  const isTall = () => deckEl.clientHeight > deckEl.clientWidth * 1.1;
  function render(force) {
    const tall = isTall();
    if (tall === tallMode && !force) return;
    if (tallMode !== null && slides[cur]) leave(cur);
    tallMode = tall;
    slides.forEach((s, i) => drawSlide(s, modFor(model.slides[i]), tall, icons));
    const s = slides[cur];
    if (s && s.classList.contains('active')) { s.classList.remove('on'); void s.offsetWidth; s.classList.add('on'); enter(cur); }
    emit('render');
  }

  function buildMarks() {
    marks.textContent = '';
    slides.forEach((s, i) => {
      const b = h('button', { type: 'button', class: 'm-' + model.slides[i].status, 'aria-label': `Slide ${i + 1}: ${model.slides[i].title}`, onclick: () => go(i) });
      b.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/></svg>';
      marks.append(h('li', {}, b));
    });
  }
  buildMarks();

  function go(i, fromHash) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    const prev = slides[cur];
    if (i !== cur && prev) {
      prev.classList.remove('active');
      prev.setAttribute('aria-hidden', 'true');
      prev.inert = true;
      leave(cur);
      clearTimeout(leaveTimers.get(prev));
      leaveTimers.set(prev, setTimeout(() => prev.classList.remove('on'), still() ? 0 : 600));
    }
    const s = slides[i];
    clearTimeout(leaveTimers.get(s));
    const fresh = i !== cur || !s.classList.contains('active');
    if (fresh) { s.classList.remove('on'); void s.offsetWidth; }
    s.classList.add('active', 'on');
    s.removeAttribute('aria-hidden');
    s.inert = false;
    const changed = i !== cur;
    cur = i;
    if (fresh) enter(i);
    $$('button', marks).forEach((b, j) => b.setAttribute('aria-current', j === i ? 'true' : 'false'));
    count.textContent = `${i + 1} / ${slides.length}`;
    $('#bar').style.width = ((i + 1) / slides.length * 100) + '%';
    if (!fromHash) history.replaceState(null, '', location.pathname + location.search + '#' + (i + 1));
    if (!notesPanel.hidden) showNotes();
    if (!sourcesPanel.hidden) showSources();
    syncComments();
    if (changed || fresh) emit('slide', i);
  }
  const next = () => go(cur + 1), prev = () => go(cur - 1);

  function showNotes() {
    const s = model.slides[cur];
    notesPanel.textContent = '';
    const head = [`${s.notes.join(' ').split(/\s+/).filter(Boolean).length} words`, 'sources: S'];
    if (s.duration != null) head.unshift(`Say it in about ${formatDuration(s.duration)}`);
    notesPanel.append(h('p', { class: 'np-h', text: head.join(' · ') }));
    notesPanel.append(s.notes.length ? scriptBlock(s.notes) : h('p', { class: 'none', text: 'No script for this slide.' }));
  }
  function toggleNotes(force) {
    const show = force != null ? force : notesPanel.hidden;
    notesPanel.hidden = !show;
    $('#notes-btn').setAttribute('aria-pressed', String(show));
    if (show) { showNotes(); toggleSources(false); }
  }

  // Each slide's sources, kept out of the spoken script.
  function showSources() {
    const s = model.slides[cur];
    sourcesPanel.textContent = '';
    sourcesPanel.append(h('p', { class: 'sp-h' }, `Sources for slide ${cur + 1} · `,
      h('button', { type: 'button', class: 'linkish', text: 'all slides', onclick: () => { toggleSources(false); toggleAllSources(true); } })));
    if (s.sources.length) {
      const ul = h('ul');
      s.sources.forEach(src => { const it = h('li'); it.innerHTML = renderInline(src); ul.append(it); });
      sourcesPanel.append(ul);
    } else sourcesPanel.append(h('p', { class: 'none', text: 'No sources listed for this slide.' }));
  }
  function toggleSources(force) {
    const show = force != null ? force : sourcesPanel.hidden;
    sourcesPanel.hidden = !show;
    $('#sources-btn').setAttribute('aria-pressed', String(show));
    if (show) { showSources(); toggleNotes(false); }
  }

  function buildSources() {
    sourcesView.textContent = '';
    const close = btn('sources-close', 'Close the sources (Escape)', 'close', { class: 'btn view-close' });
    close.addEventListener('click', () => toggleAllSources(false));
    sourcesView.append(close, h('h2', { text: 'Sources' }));
    const ol = h('ol');
    model.slides.forEach((s, i) => {
      const li = h('li', { value: String(i + 1) });
      li.append(h('div', { class: 'src-title' }, h('button', { type: 'button', text: s.title, onclick: () => { toggleAllSources(false); go(i); } })));
      if (s.sources.length) {
        const ul = h('ul');
        s.sources.forEach(src => { const it = h('li'); it.innerHTML = renderInline(src); ul.append(it); });
        li.append(ul);
      } else li.append(h('p', { class: 'none', text: 'No sources listed.' }));
      ol.append(li);
    });
    sourcesView.append(ol);
  }
  function toggleAllSources(force) {
    const show = force != null ? force : sourcesView.hidden;
    if (show) buildSources();
    sourcesView.hidden = !show;
    if (show) sourcesView.focus();
  }

  function toggleTheme() {
    const t = isDark() ? 'light' : 'dark';
    root.dataset.theme = t;
    try { localStorage.setItem(themeKey, t); } catch (_) { /* storage unavailable */ }
    syncThemeLabel();
    emit('theme', t);
  }

  /* comments: files from the build plus review comments fetched later */
  let comments = (model.comments || []).slice();
  const slideFiles = i => [model.slides[i].file, model.slides[i].draw ? data.deck.dir + '/' + model.slides[i].draw : null].filter(Boolean);
  const commentsFor = i => { const files = slideFiles(i); return comments.filter(c => files.includes(c.file)); };
  function syncComments() {
    const n = commentsFor(cur).length;
    commentBadge.textContent = n ? String(n) : '';
    commentsBtn.hidden = !n && !root.classList.contains('editing');
    commentsBtn.setAttribute('aria-label', `Comments on this slide: ${n}`);
  }

  /* lazily loaded tools */
  let editor = null, recorder = null;
  async function openEditor(opts = {}) {
    if (root.dataset.recording) return;
    if (!editor) editor = (await import('./editor.js')).createEditor(api);
    editor.open(opts);
  }
  async function recorderTool() {
    if (!recorder) recorder = (await import('./recorder.js')).createRecorder(api);
    return recorder;
  }
  async function toggleRecord() {
    if (editor && editor.isOpen() && !root.dataset.recording) editor.close();
    (await recorderTool()).toggle();
  }


  $('#prev').addEventListener('click', prev);
  $('#next').addEventListener('click', next);
  $('#notes-btn').addEventListener('click', () => toggleNotes());
  $('#sources-btn').addEventListener('click', () => toggleSources());
  $('#theme-btn').addEventListener('click', toggleTheme);
  $('#edit-btn').addEventListener('click', () => (editor && editor.isOpen() ? editor.close() : openEditor()));
  $('#record-btn').addEventListener('click', e => { e.currentTarget.blur(); toggleRecord(); });
  commentsBtn.addEventListener('click', () => openEditor({ tab: 'comments' }));

  const typing = t => t && t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  const inControl = t => t && t.closest && t.closest('a, button, select, summary');
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (typing(t)) return;
    const k = e.key;
    if ((k === ' ' || k === 'Enter') && inControl(t)) return;
    if (k === 'Escape' && !sourcesView.hidden) { toggleAllSources(false); return; }
    if (k === 'Escape' && recorder && (recorder.state === 'arming' || recorder.state === 'counting')) { recorder.stop(); return; }
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); next(); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); prev(); }
    else if (k === 'Home') { e.preventDefault(); go(0); }
    else if (k === 'End') { e.preventDefault(); go(slides.length - 1); }
    else if (k === 'n' || k === 'N') toggleNotes();
    else if (k === 's' || k === 'S') toggleSources();
    else if (k === 't' || k === 'T') toggleTheme();
    else if ((k === 'e' || k === 'E') && !root.dataset.recording) { if (editor && editor.isOpen()) editor.close(); else openEditor(); }
    else if (k === 'r' || k === 'R') toggleRecord();
    else if ((k === 'p' || k === 'P') && recorder) recorder.pause();
  });

  // Swipe in any direction; a tap on the right of the stage advances, on the left goes back.
  let p0 = null;
  deckEl.addEventListener('pointerdown', e => {
    p0 = inControl(e.target) || root.classList.contains('editing') ? null : { x: e.clientX, y: e.clientY, t: Date.now() };
  });
  deckEl.addEventListener('pointerup', e => {
    if (!p0) return;
    const dx = e.clientX - p0.x, dy = e.clientY - p0.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (Math.max(adx, ady) > 40) {
      if (adx > ady) (dx < 0 ? next : prev)();
      else (dy < 0 ? next : prev)();
    } else if (Date.now() - p0.t < 500 && e.pointerType !== 'mouse') {
      const r = deckEl.getBoundingClientRect();
      (e.clientX > r.left + r.width * .33 ? next : prev)();
    }
    p0 = null;
  });

  let rt;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => render(), 140); }).observe(deckEl);
  addEventListener('hashchange', () => { const n = parseInt(location.hash.slice(1), 10); if (n) go(n - 1, true); });
  reduce.addEventListener('change', () => { leave(cur); enter(cur); });
  darkQ.addEventListener('change', syncThemeLabel);

  slides.forEach(s => { s.setAttribute('aria-hidden', 'true'); s.inert = true; });
  render(true);
  const start = parseInt(location.hash.slice(1), 10);
  go(start ? start - 1 : 0, true);

  const api = {
    data, model, slug, deckEl, icons,
    get cur() { return cur; },
    get slides() { return slides; },
    get comments() { return comments; },
    go, next, prev, still, isTall,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit,
    slideFiles, commentsFor,
    setComments(list) { comments = list; syncComments(); emit('comments', list); },
    syncComments,
    toggleNotes, toggleSources, toggleAllSources,
    modFor,
    // Swap in a new model for slide i (from the editor) and redraw it.
    replaceSlide(i, s, mod) {
      if (mod) { if (mod.icons) Object.assign(icons, mod.icons); mods.set(s.draw, mod); }
      if (i === cur) leave(i);
      const old = slides[i];
      model.slides[i] = s;
      const sec = buildSlide(s, i, deckModel);
      const active = old.classList.contains('active');
      if (active) sec.classList.add('active', 'on');
      else { sec.setAttribute('aria-hidden', 'true'); sec.inert = true; }
      old.replaceWith(sec);
      slides[i] = sec;
      drawSlide(sec, modFor(s), tallMode, icons);
      if (active) enter(i);
      buildMarks();
      $$('button', marks).forEach((b, j) => b.setAttribute('aria-current', j === cur ? 'true' : 'false'));
      if (!notesPanel.hidden && i === cur) showNotes();
      if (!sourcesPanel.hidden && i === cur) showSources();
      if (!sourcesView.hidden) buildSources();
      emit('replace', i);
    },
    redraw() { render(true); },
    openEditor, toggleRecord,
    get recorder() { return recorder; },
    get editor() { return editor; },
  };

  if (qs.get('notes') === '1') toggleNotes(true);
  if (qs.get('sources') === '1') toggleSources(true);
  if (qs.get('edit') === '1') openEditor();
  return api;
}
