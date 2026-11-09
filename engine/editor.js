// Edit mode: the deck beside a panel that edits the current slide's Markdown
// (with the slide redrawn as you type), its spoken script, its sources and
// its drawing module, and that lists and posts comments. Saving goes through
// the GitHub persistence layer with the viewer's own token.

import { parseSlide, setField, locate, linesOfRange, formatDuration, speakingSeconds } from './loader.js';
import { GitHubClient, DeckStore, ConflictError } from './github.js';
import { loadToken, saveToken, clearToken, cleanToken } from './auth.js';
import { h, icon, loadDrawModule } from './runtime.js';

const TABS = [
  ['source', 'Slide'],
  ['script', 'Script'],
  ['sources', 'Sources'],
  ['drawing', 'Drawing'],
  ['comments', 'Comments'],
];

const fmtDate = s => { const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10); };
const lineLabel = (line, end) => (line == null ? 'whole file' : `line ${line}${end && end !== line ? '–' + end : ''}`);

export function createEditor(deck) {
  const root = document.documentElement;
  const data = deck.data;
  const repo = data.repo;
  const deckDir = data.deck.dir;
  const wasStill = root.classList.contains('still');

  // Every file this session can change, by repository path.
  const files = new Map();
  data.slides.forEach((s, i) => files.set(s.file, { path: s.file, base: s.raw, text: s.raw, kind: 'slide', index: i }));
  const drawPath = s => (s.draw ? `${deckDir}/${s.draw}` : null);
  const changed = () => [...files.values()].filter(f => f.text !== f.base);

  let token = loadToken();
  let login = null;
  let tab = 'source';
  let anchor = null;
  let isOpen = false;
  const slide = () => deck.model.slides[deck.cur];
  const slideFile = () => files.get(slide().file);

  /* ---------- panel ---------- */
  const fileLabel = h('span', { class: 'file' });
  const closeBtn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Close the editor (E)', title: 'Close the editor (E)' }, icon('close'));
  const tabBtns = {};
  const panels = {};
  const tablist = h('div', { role: 'tablist', 'aria-label': 'Editor' });
  for (const [id, label] of TABS) {
    tabBtns[id] = h('button', { role: 'tab', type: 'button', id: `tab-${id}`, 'aria-controls': `panel-${id}`, 'aria-selected': 'false', tabindex: '-1', text: label });
    tabBtns[id].addEventListener('click', () => show(id));
    tablist.append(tabBtns[id]);
  }
  tablist.addEventListener('keydown', e => {
    const ids = TABS.map(t => t[0]).filter(id => !tabBtns[id].hidden);
    const at = ids.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      const next = ids[(at + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      show(next);
      tabBtns[next].focus();
    }
  });

  const ta = (id, label) => h('textarea', { id, spellcheck: 'false', 'aria-label': label, autocomplete: 'off', autocapitalize: 'off' });
  const srcTa = ta('ed-source', 'Slide Markdown');
  const srcErr = h('p', { class: 'err', 'aria-live': 'polite' });
  const scriptTa = ta('ed-script', 'Spoken script, one line per line read aloud');
  scriptTa.spellcheck = true;
  const scriptHint = h('p', { class: 'hint', 'aria-live': 'polite' });
  const sourcesTa = ta('ed-sources', 'Sources, one per line');
  sourcesTa.spellcheck = true;
  const drawTa = ta('ed-drawing', 'Drawing module');
  const drawErr = h('p', { class: 'err', 'aria-live': 'polite' });
  const applyBtn = h('button', { class: 'act', type: 'button', text: 'Redraw (Ctrl+Enter)' });
  const drawHint = h('p', { class: 'hint', text: 'Redraw imports this text as the drawing module. It cannot import other files by relative path.' });

  panels.source = h('section', { role: 'tabpanel', id: 'panel-source', 'aria-labelledby': 'tab-source' }, srcTa,
    h('div', {}, srcErr, h('p', { class: 'hint', text: 'The slide redraws as you type. Select text here or on the slide to comment on it.' })));
  panels.script = h('section', { role: 'tabpanel', id: 'panel-script', 'aria-labelledby': 'tab-script' }, scriptTa,
    h('div', {}, scriptHint, h('p', { class: 'hint', text: 'One short line per line read aloud; a blank line is a pause. Saved as notes in the front matter.' })));
  panels.sources = h('section', { role: 'tabpanel', id: 'panel-sources', 'aria-labelledby': 'tab-sources' }, sourcesTa,
    h('p', { class: 'hint', text: 'One source per line; Markdown links work. Press S to see every slide\'s sources.' }));
  panels.drawing = h('section', { role: 'tabpanel', id: 'panel-drawing', 'aria-labelledby': 'tab-drawing' }, drawTa,
    h('div', { class: 'row' }, applyBtn, drawErr), drawHint);
  panels.drawing.style.gridTemplateRows = 'minmax(0, 1fr) auto auto';

  const commentList = h('ol', { class: 'comments', 'aria-live': 'polite' });
  const anchorLabel = h('p', { class: 'anchor' });
  const commentTa = h('textarea', { id: 'ed-comment', 'aria-label': 'Comment' });
  const postBtn = h('button', { class: 'act primary', type: 'button', text: 'Post comment' });
  const wholeBtn = h('button', { class: 'act', type: 'button', text: 'Comment on the whole slide' });
  const commentResult = h('p', { class: 'result', 'aria-live': 'polite' });
  const composer = h('div', { class: 'composer' }, anchorLabel, commentTa, h('div', { class: 'row' }, postBtn, wholeBtn), commentResult);
  panels.comments = h('section', { role: 'tabpanel', id: 'panel-comments', 'aria-labelledby': 'tab-comments', class: 'list' }, commentList, composer,
    h('p', { class: 'hint', text: 'A comment on a file an open pull request changes is posted there as a review comment. Otherwise it is committed as a file under the deck\'s comments/ folder, with a pull request.' }));

  // Sign-in and saving.
  const tokenIn = h('input', { type: 'password', id: 'ed-token', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'GitHub token', placeholder: 'github_pat_…' });
  const signInBtn = h('button', { class: 'act primary', type: 'button', text: 'Sign in' });
  const signInMsg = h('p', { class: 'hint', 'aria-live': 'polite' });
  const repoName = repo ? `${repo.owner}/${repo.name}` : null;
  const signIn = h('div', { class: 'signin' },
    h('p', { class: 'hint' }, 'Sign in to save. Paste a ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'fine-grained token' }),
      ` with read and write access to Contents and Pull requests${repoName ? ' on ' + repoName : ''}. It stays in this tab only and is sent only to api.github.com.`),
    h('div', { class: 'row' }, tokenIn, signInBtn), signInMsg);
  const who = h('span', { class: 'hint' });
  const signOutBtn = h('button', { class: 'act', type: 'button', text: 'Sign out' });
  const whoRow = h('div', { class: 'row', hidden: true }, who, signOutBtn);
  const changedList = h('p', { class: 'changed' });
  const msgIn = h('input', { type: 'text', id: 'ed-message', 'aria-label': 'Commit message', placeholder: 'Commit message' });
  const saveBtn = h('button', { class: 'act primary', type: 'button', text: 'Save to GitHub' });
  const discardBtn = h('button', { class: 'act', type: 'button', text: 'Discard changes' });
  const saveResult = h('p', { class: 'result', 'aria-live': 'polite' });
  const footer = h('footer', {}, signIn, whoRow, changedList, msgIn, h('div', { class: 'row' }, saveBtn, discardBtn), saveResult);
  if (!repo) {
    signIn.hidden = true;
    saveResult.textContent = 'This build names no repository, so it cannot save. Build with --repo owner/name.';
  }

  const panel = h('aside', { id: 'editor', 'aria-label': 'Editor', hidden: true },
    h('header', {}, h('h2', { text: 'Edit' }), closeBtn, fileLabel),
    tablist,
    h('div', { style: 'min-height:0;display:grid' }, ...Object.values(panels)),
    footer);
  document.body.append(panel);
  const selBtn = h('button', { id: 'sel-comment', type: 'button', hidden: true, text: 'Comment' });
  document.body.append(selBtn);

  /* ---------- state into the panel ---------- */
  function show(id) {
    if (tabBtns[id].hidden) id = 'source';
    tab = id;
    for (const [k] of TABS) {
      const on = k === id;
      tabBtns[k].setAttribute('aria-selected', String(on));
      tabBtns[k].tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    }
    if (id === 'drawing') loadDrawing();
    if (id === 'comments') renderComments();
  }

  function fillFromSlide() {
    const s = slide();
    const f = slideFile();
    const ghUrl = repo ? `https://github.com/${repo.owner}/${repo.name}/blob/${repo.sha || repo.ref}/${s.file}` : null;
    fileLabel.textContent = '';
    fileLabel.append(ghUrl ? h('a', { href: ghUrl, target: '_blank', rel: 'noopener', text: s.file }) : s.file);
    if (document.activeElement !== srcTa) srcTa.value = f.text;
    if (document.activeElement !== scriptTa) scriptTa.value = scriptText(f.text, s);
    if (document.activeElement !== sourcesTa) sourcesTa.value = s.sources.join('\n');
    syncScriptHint(s);
    tabBtns.drawing.hidden = !s.draw;
    if (tab === 'drawing' && !s.draw) show('source');
    else if (tab === 'drawing') loadDrawing();
    tabBtns.comments.textContent = `Comments (${deck.commentsFor(deck.cur).length})`;
    if (tab === 'comments') renderComments();
    if (!anchor || !deck.slideFiles(deck.cur).includes(anchor.file)) setAnchor(null);
    srcErr.textContent = '';
    syncFooter();
  }

  // The script as written: the notes block's lines, blank lines kept.
  function scriptText(text, s) {
    const m = /^notes:[ \t]*[|>][-+0-9]*[ \t]*\n((?:(?:[ \t]+.*)?\n)*)/m.exec(text.split(/\n---[ \t]*\n/)[0] + '\n');
    if (m) return m[1].replace(/\n+$/, '').split('\n').map(l => l.trim()).join('\n');
    return s.notes.join('\n');
  }

  function syncScriptHint(s) {
    const est = speakingSeconds(s.notes);
    const over = s.duration != null && est > s.duration * 1.1;
    scriptHint.className = 'hint' + (over ? ' over' : '');
    scriptHint.textContent = `About ${formatDuration(est)} read aloud at 150 words a minute` + (s.duration != null ? `; target ${formatDuration(s.duration)}.` : '.');
  }

  function syncFooter() {
    const list = changed();
    changedList.textContent = list.length ? 'Changed: ' + list.map(f => f.path).join(', ') : 'No changes yet.';
    saveBtn.disabled = !list.length || !repo;
    discardBtn.disabled = !list.length;
    signIn.hidden = !repo || !!login;
    whoRow.hidden = !login;
    who.textContent = login ? `Signed in as ${login}` : '';
    if (!msgIn.value && list.length === 1) msgIn.placeholder = `Edit ${list[0].path.split('/').pop()}`;
    else if (list.length > 1) msgIn.placeholder = `Edit ${list.length} files in ${deckDir}`;
  }

  /* ---------- live preview ---------- */
  let previewTimer = null;
  function setSlideText(text, from) {
    const f = slideFile();
    const i = deck.cur;
    f.text = text;
    if (from !== 'source') srcTa.value = text;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => preview(i, f), from === 'source' ? 180 : 60);
    syncFooter();
  }
  function preview(i, f) {
    let s;
    try {
      s = parseSlide(f.text, f.path);
    } catch (e) {
      srcErr.textContent = e.message;
      return;
    }
    srcErr.textContent = '';
    const known = s.draw ? deck.modFor(s) : null;
    if (s.draw && !known) {
      loadDrawModule(new URL(s.draw, location.href).href).then(mod => deck.replaceSlide(i, s, mod));
    } else deck.replaceSlide(i, s);
    if (i === deck.cur) {
      if (document.activeElement !== scriptTa) scriptTa.value = scriptText(f.text, s);
      if (document.activeElement !== sourcesTa) sourcesTa.value = s.sources.join('\n');
      syncScriptHint(s);
      tabBtns.drawing.hidden = !s.draw;
    }
  }
  srcTa.addEventListener('input', () => setSlideText(srcTa.value, 'source'));
  scriptTa.addEventListener('input', () => {
    try { setSlideText(setField(slideFile().text, 'notes', scriptTa.value.split('\n')), 'script'); } catch (e) { srcErr.textContent = e.message; }
  });
  sourcesTa.addEventListener('input', () => {
    try { setSlideText(setField(slideFile().text, 'sources', sourcesTa.value.split('\n')), 'sources'); } catch (e) { srcErr.textContent = e.message; }
  });

  /* ---------- drawing modules ---------- */
  async function loadDrawing() {
    const s = slide();
    const path = drawPath(s);
    if (!path) return;
    drawTa.dataset.path = path;
    let f = files.get(path);
    if (!f) {
      drawTa.value = 'Loading…';
      try {
        const res = await fetch(new URL(s.draw, location.href).href, { cache: 'no-store' });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const text = await res.text();
        f = files.get(path) || { path, base: text, text, kind: 'draw', draw: s.draw };
        files.set(path, f);
      } catch (e) {
        drawErr.textContent = `Could not load ${s.draw}: ${e.message}`;
        return;
      }
    }
    if (drawTa.dataset.path === path && document.activeElement !== drawTa) drawTa.value = f.text;
  }
  drawTa.addEventListener('input', () => {
    const f = files.get(drawTa.dataset.path);
    if (f) { f.text = drawTa.value; syncFooter(); }
  });
  async function applyDrawing() {
    const f = files.get(drawTa.dataset.path);
    if (!f) return;
    const url = URL.createObjectURL(new Blob([f.text], { type: 'text/javascript' }));
    const mod = await loadDrawModule(url);
    URL.revokeObjectURL(url);
    if (mod.error) { drawErr.textContent = mod.error; return; }
    drawErr.textContent = '';
    deck.model.slides.forEach((s, i) => { if (s.draw === f.draw) deck.replaceSlide(i, s, mod); });
  }
  applyBtn.addEventListener('click', applyDrawing);
  drawTa.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyDrawing(); } });

  /* ---------- signing in ---------- */
  function store() {
    return new DeckStore({ client: new GitHubClient({ token }), repo, deckDir });
  }
  async function verify(t) {
    const me = await new GitHubClient({ token: t }).get('/user');
    return me.login;
  }
  signInBtn.addEventListener('click', async () => {
    const t = cleanToken(tokenIn.value);
    if (!t) { signInMsg.textContent = 'That does not look like a GitHub token (github_pat_…, ghp_…).'; return; }
    signInBtn.disabled = true;
    signInMsg.textContent = 'Checking the token…';
    try {
      login = await verify(t);
      token = t;
      saveToken(t);
      tokenIn.value = '';
      signInMsg.textContent = '';
    } catch (e) {
      signInMsg.textContent = `GitHub refused the token: ${e.message}`;
    } finally {
      signInBtn.disabled = false;
      syncFooter();
    }
  });
  tokenIn.addEventListener('keydown', e => { if (e.key === 'Enter') signInBtn.click(); });
  signOutBtn.addEventListener('click', () => { clearToken(); token = null; login = null; syncFooter(); });
  if (token && repo) verify(token).then(l => { login = l; syncFooter(); }).catch(() => { clearToken(); token = null; syncFooter(); });

  /* ---------- saving ---------- */
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', text });
  async function save() {
    const list = changed();
    if (!list.length || !repo) return;
    if (!login) { saveResult.textContent = 'Sign in first.'; tokenIn.focus(); return; }
    for (const f of list) {
      if (f.kind !== 'slide') continue;
      try { parseSlide(f.text, f.path); } catch (e) { saveResult.textContent = `Not saved: ${e.message}`; return; }
    }
    saveBtn.disabled = true;
    saveResult.textContent = 'Saving…';
    try {
      const message = msgIn.value.trim() || msgIn.placeholder;
      const r = await store().saveEdit({ files: list.map(f => ({ path: f.path, content: f.text, base: f.base })), message });
      list.forEach(f => { f.base = f.text; });
      msgIn.value = '';
      saveResult.textContent = '';
      saveResult.append(`Committed to ${r.branch}: `, link(r.commit.url, r.commit.sha.slice(0, 7)), r.createdPr ? ', opened ' : ', added to ', link(r.pr.url, `pull request #${r.pr.number}`), '.');
    } catch (e) {
      saveResult.textContent = e instanceof ConflictError ? e.message : `Not saved: ${e.message}`;
    } finally {
      syncFooter();
    }
  }
  saveBtn.addEventListener('click', save);
  discardBtn.addEventListener('click', async () => {
    for (const f of changed()) {
      f.text = f.base;
      if (f.kind === 'slide') deck.replaceSlide(f.index, parseSlide(f.base, f.path));
      else if (f.kind === 'draw') {
        // The module as published: edits were imported from blob URLs, so this is the original.
        const mod = await loadDrawModule(new URL(f.draw, location.href).href);
        deck.model.slides.forEach((s, i) => { if (s.draw === f.draw) deck.replaceSlide(i, s, mod); });
      }
    }
    fillFromSlide();
    if (drawTa.dataset.path && files.get(drawTa.dataset.path)) drawTa.value = files.get(drawTa.dataset.path).text;
    drawErr.textContent = '';
    syncFooter();
  });
  panel.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
  });
  addEventListener('beforeunload', e => { if (changed().length) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- comments ---------- */
  function renderComments() {
    const list = deck.commentsFor(deck.cur);
    tabBtns.comments.textContent = `Comments (${list.length})`;
    commentList.textContent = '';
    if (!list.length) commentList.append(h('li', { class: 'hint', text: 'No comments on this slide yet.' }));
    for (const c of list) {
      const where = c.file === slide().file ? lineLabel(c.line, c.endLine) : `${c.file.split('/').pop()}, ${lineLabel(c.line, c.endLine)}`;
      const meta = h('p', { class: 'meta' }, h('strong', { text: c.author || 'someone' }), h('span', { text: fmtDate(c.created) }), h('span', { text: where + (c.outdated ? ' (outdated)' : '') }));
      if (c.url) meta.append(link(c.url, c.pr ? `pull request #${c.pr}` : 'commit'));
      else if (c.kind === 'file') meta.append(h('span', { text: 'comment file' }));
      commentList.append(h('li', { class: 'comment' }, meta, c.quote ? h('blockquote', { text: c.quote }) : null, h('p', { class: 'body', text: c.body })));
    }
    syncComposer();
  }
  function setAnchor(a) {
    anchor = a;
    syncComposer();
  }
  function syncComposer() {
    const a = anchor || { file: slide().file, line: null };
    anchorLabel.textContent = '';
    anchorLabel.append(`On ${a.file}, ${lineLabel(a.line, a.endLine)}`);
    if (a.quote) anchorLabel.append(h('br'), `“${a.quote.length > 160 ? a.quote.slice(0, 160) + '…' : a.quote}”`);
    wholeBtn.hidden = !anchor;
    postBtn.disabled = !repo;
  }
  wholeBtn.addEventListener('click', () => setAnchor(null));
  postBtn.addEventListener('click', async () => {
    if (!login) { commentResult.textContent = 'Sign in first.'; tokenIn.focus(); return; }
    const body = commentTa.value.trim();
    if (!body) { commentResult.textContent = 'Write a comment first.'; commentTa.focus(); return; }
    const a = anchor || { file: slide().file, line: null, endLine: null, quote: '' };
    postBtn.disabled = true;
    commentResult.textContent = 'Posting…';
    try {
      const r = await store().saveComment({ anchor: a, body });
      commentTa.value = '';
      commentResult.textContent = '';
      if (r.kind === 'file') commentResult.append('Saved as ', h('code', { text: r.path.split('/').pop() }), ' in ', link(r.pr.url, `pull request #${r.pr.number}`), '.');
      else commentResult.append(r.kind === 'review-line' ? 'Posted on the line in ' : 'Posted on the file in ', link(r.url, `pull request #${r.pr.number}`), '.');
      deck.setComments([...deck.comments, r.comment]);
      setAnchor(null);
      renderComments();
    } catch (e) {
      commentResult.textContent = `Not posted: ${e.message}`;
    } finally {
      postBtn.disabled = !repo;
    }
  });

  // An anchor from the current selection: in a textarea, on the slide or in the notes panel.
  function selectionAnchor() {
    const s = slide();
    const sf = slideFile();
    const el = document.activeElement;
    if (el === srcTa || el === drawTa || el === scriptTa || el === sourcesTa) {
      if (el.selectionStart === el.selectionEnd) return null;
      const quote = el.value.slice(el.selectionStart, el.selectionEnd).trim();
      if (!quote) return null;
      if (el === drawTa) {
        const f = files.get(drawTa.dataset.path);
        const r = linesOfRange(el.value, el.selectionStart, el.selectionEnd);
        const at = f && f.text !== f.base ? locate(f.base, quote, r.line) || r : r;
        return { file: drawTa.dataset.path, ...at, quote };
      }
      const near = el === srcTa ? linesOfRange(el.value, el.selectionStart, el.selectionEnd)
        : { line: el === scriptTa ? (s.lines.notes[0] || 1) : (s.lines.sources[0] || 1) };
      const at = (el === srcTa && sf.text === sf.base) ? near : (locate(sf.base, quote, near.line) || { line: near.line, endLine: near.endLine || near.line });
      return { file: s.file, ...at, quote };
    }
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const quote = sel.toString().trim();
    if (!quote) return null;
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (!node || !node.closest('#deck .slide.active, #notes-panel')) return null;
    const block = node.closest('[data-line]');
    const near = block ? Number(block.dataset.line) : s.lines.body;
    const found = locate(sf.base, quote, near);
    if (found) return { file: s.file, ...found, quote };
    if (block) return { file: s.file, line: near, endLine: Number(block.dataset.lineEnd || near), quote };
    return { file: s.file, line: null, endLine: null, quote };
  }
  let pending = null;
  function onSelect() {
    if (!isOpen) return;
    const a = selectionAnchor();
    pending = a;
    if (!a) { selBtn.hidden = true; return; }
    const el = document.activeElement;
    let r;
    if (el && el.tagName === 'TEXTAREA') r = el.getBoundingClientRect();
    else r = getSelection().getRangeAt(0).getBoundingClientRect();
    selBtn.style.left = `${Math.max(40, Math.min(innerWidth - 40, r.left + r.width / 2))}px`;
    selBtn.style.top = `${Math.max(36, r.top - 6)}px`;
    selBtn.hidden = false;
  }
  let selTimer = null;
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(onSelect, 120); });
  for (const t of [srcTa, drawTa, scriptTa, sourcesTa]) t.addEventListener('select', onSelect);
  selBtn.addEventListener('mousedown', e => e.preventDefault());
  selBtn.addEventListener('click', () => {
    if (!pending) return;
    setAnchor(pending);
    selBtn.hidden = true;
    show('comments');
    commentTa.focus();
  });

  closeBtn.addEventListener('click', () => close());
  deck.on('slide', () => { if (isOpen) fillFromSlide(); });
  deck.on('comments', () => { if (isOpen) { tabBtns.comments.textContent = `Comments (${deck.commentsFor(deck.cur).length})`; if (tab === 'comments') renderComments(); } });

  function open(opts = {}) {
    isOpen = true;
    root.classList.add('editing', 'still');
    panel.hidden = false;
    document.getElementById('edit-btn').setAttribute('aria-pressed', 'true');
    deck.syncComments();
    fillFromSlide();
    show(opts.tab || tab);
    const u = new URL(location.href);
    u.searchParams.set('edit', '1');
    history.replaceState(null, '', u);
    (opts.tab === 'comments' ? tabBtns.comments : srcTa).focus({ preventScroll: true });
  }
  function close() {
    isOpen = false;
    root.classList.remove('editing');
    if (!wasStill) root.classList.remove('still');
    panel.hidden = true;
    selBtn.hidden = true;
    document.getElementById('edit-btn').setAttribute('aria-pressed', 'false');
    deck.syncComments();
    const u = new URL(location.href);
    u.searchParams.delete('edit');
    history.replaceState(null, '', u);
    document.getElementById('edit-btn').focus({ preventScroll: true });
  }

  return { open, close, isOpen: () => isOpen, files, changed };
}
