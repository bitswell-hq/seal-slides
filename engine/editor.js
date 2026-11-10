// Edit mode: the deck beside a panel that edits the current slide's Markdown
// (with the slide redrawn as you type), its spoken script, its sources and
// its drawing module, and that lists and posts comments. Saving goes through
// the GitHub persistence layer with the viewer's own token.

import { parseSlide, setField, locate, linesOfRange, formatDuration, speakingSeconds } from './loader.js';
import { GitHubClient, DeckStore, GitHubError, ConflictError } from './github.js';
import { loadToken, saveToken, clearToken, cleanToken, standsAlone } from './auth.js';
import { h, icon, loadDrawModule, loadDeckDrawing, drawUrl } from './runtime.js';

const TABS = [
  ['source', 'Slide'],
  ['script', 'Script'],
  ['sources', 'Sources'],
  ['drawing', 'Drawing'],
  ['comments', 'Comments'],
];

const fmtDate = s => { const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10); };
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', text });
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

  let login = null;
  let tab = 'source';
  let anchor = null;
  let isOpen = false;
  // One request that writes to GitHub, or reads what the next one builds on, at a time.
  let busy = false;
  // The viewer's open pull request is being read; nothing is typed until it has been.
  let loading = false;
  // The viewer's open pull request and the files it holds that are not loaded yet.
  let mine = null;
  // The file the slide textareas hold.
  let filled = null;
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
  const prDrawNote = h('span', { class: 'hint', 'aria-live': 'polite' });
  const prDrawBtn = h('button', { class: 'act', type: 'button', text: 'Load drawing from your PR' });
  const prDraw = h('div', { class: 'row', id: 'ed-pr-drawing', hidden: true }, prDrawNote, prDrawBtn);
  panels.drawing = h('section', { role: 'tabpanel', id: 'panel-drawing', 'aria-labelledby': 'tab-drawing' }, drawTa,
    h('div', {}, prDraw, h('div', { class: 'row' }, applyBtn, drawErr), drawHint));

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
  const signIn = !standsAlone() ? h('div', { class: 'signin' },
    h('p', { class: 'hint', text: 'Signing in is off here, because this page is inside a frame or was opened by another page, which could read your token. Open this address in a new tab yourself to edit.' })) : h('div', { class: 'signin' },
    h('p', { class: 'hint' }, 'Sign in to edit. Paste a ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'fine-grained token' }),
      ` limited to ${repoName || 'this repository'}, with read and write access to Contents and Pull requests. Without push access${repoName ? ' to ' + repoName : ''}, a `,
      h('a', { href: 'https://github.com/settings/tokens/new', target: '_blank', rel: 'noopener', text: 'classic token' }),
      ' with the public_repo scope works instead, and your edits go through your fork; that token can write to all your public repositories. The token is kept in memory only, until you reload or close this page, and is sent only to api.github.com.'),
    h('div', { class: 'row' }, tokenIn, signInBtn), signInMsg);
  const who = h('span', { class: 'hint' });
  const signOutBtn = h('button', { class: 'act', type: 'button', text: 'Sign out' });
  const whoRow = h('div', { class: 'row', hidden: true }, who, signOutBtn);
  const pendingNote = h('p', { class: 'hint', 'aria-live': 'polite', hidden: true });
  const changedList = h('p', { class: 'changed' });
  const msgIn = h('input', { type: 'text', id: 'ed-message', 'aria-label': 'Commit message', placeholder: 'Commit message' });
  const saveBtn = h('button', { class: 'act primary', type: 'button', text: 'Save to GitHub' });
  const discardBtn = h('button', { class: 'act', type: 'button', text: 'Discard changes' });
  const saveResult = h('p', { class: 'result', 'aria-live': 'polite' });
  const footer = h('footer', {}, signIn, whoRow, pendingNote, changedList, msgIn, h('div', { class: 'row' }, saveBtn, discardBtn), saveResult);
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
    const typingIn = f === filled ? document.activeElement : null;
    filled = f;
    if (typingIn !== srcTa) srcTa.value = f.text;
    if (typingIn !== scriptTa) scriptTa.value = scriptText(f.text, s);
    if (typingIn !== sourcesTa) sourcesTa.value = s.sources.join('\n');
    syncScriptHint(s);
    tabBtns.drawing.hidden = !s.draw;
    if (tab === 'drawing' && !s.draw) show('source');
    else if (tab === 'drawing') loadDrawing();
    tabBtns.comments.textContent = `Comments (${deck.commentsFor(deck.cur).length})`;
    if (tab === 'comments') renderComments();
    if (!anchor || !deck.slideFiles(deck.cur).includes(anchor.file)) setAnchor(null);
    try { parseSlide(f.text, f.path); srcErr.textContent = ''; } catch (e) { srcErr.textContent = e.message; }
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
    saveBtn.disabled = busy || !list.length || !repo;
    discardBtn.disabled = !list.length;
    const waiting = mine ? list.filter(f => mine.files.has(f.path)) : [];
    const drawings = mine ? [...new Set(deck.model.slides.map(drawPath))].filter(p => p && mine.files.has(p)) : [];
    const names = l => l.map(x => x.split('/').pop()).join(', ');
    pendingNote.textContent = '';
    pendingNote.hidden = !mine || !(mine.loaded.length || waiting.length || drawings.length);
    if (!pendingNote.hidden) {
      const pr = link(mine.pr.url, `pull request #${mine.pr.number}`);
      if (mine.loaded.length) pendingNote.append(`Editing ${names(mine.loaded)} as saved in your open `, pr, '.');
      else pendingNote.append('Your open ', pr, ' is where saves go.');
      if (waiting.length) pendingNote.append(` It holds a newer ${names(waiting.map(f => f.path))}; copy your text, then load the newer version.`);
      if (drawings.length) pendingNote.append(` It changes ${names(drawings)}, which is not drawn until you load it in the Drawing tab.`);
    }
    const locked = !!repo && (!login || loading);
    const d = files.get(drawTa.dataset.path);
    const held = !!d && drawings.includes(d.path);
    prDraw.hidden = !held;
    prDrawNote.textContent = held ? `Your pull request #${mine.pr.number} holds another version of ${names([d.path])}, last changed there by ${mine.authors.get(d.path) || 'someone unknown'}. Loading it runs it in this page.` : '';
    for (const t of [srcTa, scriptTa, sourcesTa]) t.readOnly = locked;
    drawTa.readOnly = locked || held;
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
      loadDeckDrawing(s.draw).then(mod => deck.replaceSlide(i, s, mod));
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
  // Register a slide's drawing module as a file of this session, from the
  // published module.
  async function openDrawing(s) {
    const path = drawPath(s);
    const res = await fetch(drawUrl(s.draw), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    let f = files.get(path);
    if (f) return f;
    f = { path, base: text, text, built: text, kind: 'draw', draw: s.draw };
    files.set(path, f);
    adopt(f);
    return f;
  }
  async function loadDrawing() {
    const s = slide();
    const path = drawPath(s);
    if (!path) return;
    const moved = drawTa.dataset.path !== path;
    drawTa.dataset.path = path;
    let f = files.get(path);
    if (!f) {
      drawTa.value = 'Loading…';
      try {
        f = await openDrawing(s);
      } catch (e) {
        drawErr.textContent = `Could not load ${s.draw}: ${e.message}`;
        return;
      }
    }
    if (drawTa.dataset.path === path && (moved || document.activeElement !== drawTa)) drawTa.value = f.text;
    syncFooter();
  }
  // The pull request's version of a drawing module is script anyone who can
  // push to its branch may have written, so it runs only when asked for.
  prDrawBtn.addEventListener('click', async () => {
    const f = files.get(drawTa.dataset.path);
    const text = f && mine ? mine.files.get(f.path) : undefined;
    if (text === undefined) return;
    mine.files.delete(f.path);
    f.base = f.text = text;
    mine.loaded.push(f.path);
    drawTa.value = text;
    syncFooter();
    await redraw(f);
  });
  drawTa.addEventListener('input', () => {
    const f = files.get(drawTa.dataset.path);
    if (f) { f.text = drawTa.value; syncFooter(); }
  });
  // Draw the slides of a drawing module from its text in the editor: the
  // published module when the text is the built one, otherwise the text itself.
  async function redraw(f) {
    const edited = f.text !== f.built;
    const url = edited ? URL.createObjectURL(new Blob([f.text], { type: 'text/javascript' })) : drawUrl(f.draw);
    const mod = await loadDrawModule(url);
    if (edited) URL.revokeObjectURL(url);
    if (mod.error) { drawErr.textContent = mod.error; return; }
    drawErr.textContent = '';
    deck.model.slides.forEach((s, i) => { if (s.draw === f.draw) deck.replaceSlide(i, s, mod); });
  }
  function applyDrawing() {
    const f = files.get(drawTa.dataset.path);
    if (f) redraw(f);
  }
  applyBtn.addEventListener('click', applyDrawing);
  drawTa.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); applyDrawing(); } });

  /* ---------- signing in ---------- */
  function store() {
    return new DeckStore({ client: new GitHubClient({ token: loadToken() }), repo, deckDir });
  }
  async function verify(t) {
    const me = await new GitHubClient({ token: t }).get('/user');
    return me.login;
  }

  // Take the pull request's version of a slide as what the editor edits.
  // A file with unsaved changes keeps them; discarding them loads it. A
  // drawing module is never taken here: see prDrawBtn.
  function adopt(f) {
    const text = mine ? mine.files.get(f.path) : undefined;
    if (text === undefined) return;
    if (text === f.base) { mine.files.delete(f.path); return; }
    if (f.kind === 'draw' || f.text !== f.base) return;
    mine.files.delete(f.path);
    f.base = f.text = text;
    mine.loaded.push(f.path);
  }
  function refill() {
    filled = null;
    fillFromSlide();
    const d = files.get(drawTa.dataset.path);
    if (d) drawTa.value = d.text;
  }
  async function loadPending() {
    if (busy) return;
    busy = loading = true;
    syncFooter();
    syncComposer();
    const t = loadToken();
    try {
      const p = await store().pending();
      if (loadToken() !== t) return;
      mine = p && { ...p, loaded: [] };
      if (!mine) return;
      let took = false;
      for (const f of files.values()) {
        const was = f.text;
        adopt(f);
        if (f.text === was) continue;
        took = true;
        preview(f.index, f);
      }
      if (took && isOpen) refill();
    } catch (e) {
      saveResult.textContent = `Could not check for your open pull request: ${e.message}`;
    } finally {
      busy = loading = false;
      syncFooter();
      syncComposer();
    }
  }
  signInBtn.addEventListener('click', async () => {
    const t = cleanToken(tokenIn.value);
    if (!t) { signInMsg.textContent = 'That does not look like a GitHub token (github_pat_…, ghp_…).'; return; }
    signInBtn.disabled = true;
    signInMsg.textContent = 'Checking the token…';
    try {
      login = await verify(t);
      saveToken(t);
      tokenIn.value = '';
      signInMsg.textContent = '';
    } catch (e) {
      signInMsg.textContent = e instanceof GitHubError && e.status === 401 ? `GitHub refused the token: ${e.message}` : `Could not check the token, try again: ${e.message}`;
    } finally {
      signInBtn.disabled = false;
      syncFooter();
    }
    if (loadToken() === t) loadPending();
  });
  tokenIn.addEventListener('keydown', e => { if (e.key === 'Enter') signInBtn.click(); });
  signOutBtn.addEventListener('click', () => { clearToken(); login = null; mine = null; syncFooter(); });

  /* ---------- saving ---------- */
  async function save() {
    if (busy) return;
    const list = changed();
    if (!list.length || !repo) return;
    if (!login) { saveResult.textContent = 'Sign in first.'; tokenIn.focus(); return; }
    for (const f of list) {
      if (f.kind !== 'slide') continue;
      try { parseSlide(f.text, f.path); } catch (e) { saveResult.textContent = `Not saved: ${e.message}`; return; }
    }
    busy = true;
    syncFooter();
    syncComposer();
    saveResult.textContent = 'Saving…';
    let conflict = false;
    try {
      const message = msgIn.value.trim() || msgIn.placeholder;
      const sent = list.map(f => ({ path: f.path, content: f.text, base: f.base }));
      const r = await store().saveEdit({ files: sent, message });
      for (const x of sent) {
        files.get(x.path).base = x.content;
        if (mine) mine.files.delete(x.path);
      }
      msgIn.value = '';
      saveResult.textContent = '';
      saveResult.append(`Committed to ${r.branch}: `, link(r.commit.url, r.commit.sha.slice(0, 7)), r.createdPr ? ', opened ' : ', added to ', link(r.pr.url, `pull request #${r.pr.number}`), '.');
    } catch (e) {
      conflict = e instanceof ConflictError;
      saveResult.textContent = '';
      if (conflict) conflict = e;
      else saveResult.append(`Not saved: ${e.message}`);
    } finally {
      busy = false;
      syncFooter();
      syncComposer();
    }
    if (!conflict) return;
    await loadPending();
    const f = files.get(conflict.path);
    const copyBtn = h('button', { class: 'act', type: 'button', text: 'Copy my text' });
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(f.text); copyBtn.textContent = 'Copied'; } catch (_) { copyBtn.textContent = 'Could not copy; select it in the editor'; }
    });
    const loadBtn = h('button', { class: 'act', type: 'button', text: 'Load the newer version' });
    loadBtn.addEventListener('click', async () => {
      await reset(f);
      refill();
      saveResult.textContent = '';
    });
    saveResult.textContent = '';
    saveResult.append(`Not saved: ${f.path.split('/').pop()} changed in `, link(conflict.pr.url, `pull request #${conflict.pr.number}`),
      ` since the editor loaded it. Copy your text, then load the newer version of this file${f.kind === 'draw' ? ' in the Drawing tab' : ''}; your other changes stay. `, copyBtn);
    if (f.kind === 'slide' && mine && mine.files.has(f.path)) saveResult.append(' ', loadBtn);
  }
  saveBtn.addEventListener('click', save);
  // Back to what the editor loaded for a file, or to the pull request's newer version of it.
  async function reset(f) {
    f.text = f.base;
    adopt(f);
    if (f.kind === 'slide') preview(f.index, f);
    else await redraw(f);
  }
  discardBtn.addEventListener('click', async () => {
    for (const f of changed()) await reset(f);
    refill();
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
    postBtn.disabled = busy || !repo;
  }
  wholeBtn.addEventListener('click', () => setAnchor(null));
  postBtn.addEventListener('click', async () => {
    if (busy) return;
    if (!login) { commentResult.textContent = 'Sign in first.'; tokenIn.focus(); return; }
    const body = commentTa.value.trim();
    if (!body) { commentResult.textContent = 'Write a comment first.'; commentTa.focus(); return; }
    const a = anchor || { file: slide().file, line: null, endLine: null, quote: '' };
    busy = true;
    syncFooter();
    syncComposer();
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
      busy = false;
      syncFooter();
      syncComposer();
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
    deck.syncComments();
    fillFromSlide();
    show(opts.tab || tab);
    document.getElementById('edit-btn').setAttribute('aria-pressed', 'true');
    const u = new URL(location.href);
    u.searchParams.set('edit', '1');
    history.replaceState(null, '', u);
    (opts.tab === 'comments' ? tabBtns.comments : repo && !login && standsAlone() ? tokenIn : srcTa).focus({ preventScroll: true });
  }
  function close() {
    isOpen = false;
    root.classList.remove('editing');
    if (!wasStill) root.classList.remove('still');
    panel.hidden = true;
    selBtn.hidden = true;
    deck.syncComments();
    document.getElementById('edit-btn').setAttribute('aria-pressed', 'false');
    const u = new URL(location.href);
    u.searchParams.delete('edit');
    history.replaceState(null, '', u);
    document.getElementById('edit-btn').focus({ preventScroll: true });
  }

  return { open, close, isOpen: () => isOpen, files, changed };
}
