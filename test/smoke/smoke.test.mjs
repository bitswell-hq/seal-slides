// Headless browser smoke test: navigation, edit mode against a fake GitHub
// API, and the recorder with Chromium's fake media devices.
// Run with: npm run test:smoke (needs `npx playwright install chromium` once).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build } from '../../scripts/build.mjs';
import { serve } from '../../scripts/serve.mjs';

const REPO = { owner: 'acme', name: 'decks', ref: 'main', sha: 'built-sha' };
let dir, server, browser, base;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'seal-slides-smoke-'));
  await build({ outDir: path.join(dir, 'site'), repo: REPO });
  server = await serve(path.join(dir, 'site'), 0);
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
  if (dir) await rm(dir, { recursive: true, force: true });
});

// A fake api.github.com behind page.route. `state` records what the page sent.
function fakeGitHub(page, state) {
  const json = (route, status, body) => route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, OPTIONS' },
    body: JSON.stringify(body),
  });
  return page.route('https://api.github.com/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname + url.search;
    const m = req.method();
    if (m === 'OPTIONS') return json(route, 204, {});
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    state.calls.push({ m, p, body, auth: req.headers().authorization || null });
    if (m === 'GET' && p === '/user') return req.headers().authorization ? json(route, 200, { login: 'octo' }) : json(route, 401, { message: 'Requires authentication' });
    if (m === 'GET' && p === '/repos/acme/decks') return json(route, 200, { default_branch: 'main', permissions: { push: true } });
    if (m === 'GET' && p.startsWith('/repos/acme/decks/pulls/comments')) return json(route, 200, state.reviewComments);
    if (m === 'GET' && p.startsWith('/repos/acme/decks/pulls?state=open')) return json(route, 200, state.pulls);
    if (m === 'GET' && /^\/repos\/acme\/decks\/pulls\/7\/files/.test(p)) return json(route, 200, state.prFiles);
    const held = m === 'GET' && /^\/repos\/acme\/decks\/contents\/([^?]+)\?ref=/.exec(p);
    if (held && state.contents[decodeURIComponent(held[1])] != null) return json(route, 200, { content: Buffer.from(state.contents[decodeURIComponent(held[1])], 'utf8').toString('base64') });
    if (m === 'POST' && p === '/repos/acme/decks/git/refs') { state.branch = body.ref.replace('refs/heads/', ''); return json(route, 201, {}); }
    if (m === 'GET' && p.startsWith('/repos/acme/decks/git/ref/heads/')) return json(route, 200, { object: { sha: 'built-sha' } });
    if (m === 'GET' && p === '/repos/acme/decks/git/commits/built-sha') return json(route, 200, { tree: { sha: 'tree-1' } });
    if (m === 'POST' && p === '/repos/acme/decks/git/trees') { state.tree = body; return json(route, 201, { sha: 'tree-2' }); }
    if (m === 'POST' && p === '/repos/acme/decks/git/commits') return json(route, 201, { sha: 'commit-2', html_url: 'https://github.com/acme/decks/commit/commit-2' });
    if (m === 'PATCH' && p.startsWith('/repos/acme/decks/git/refs/heads/')) return json(route, 200, {});
    if (m === 'POST' && p === '/repos/acme/decks/pulls') {
      state.pulls = [{ number: 7, html_url: 'https://github.com/acme/decks/pull/7', user: { login: 'octo' }, head: { ref: state.branch, sha: 'built-sha', repo: { full_name: 'acme/decks', name: 'decks', owner: { login: 'acme' } } }, base: { ref: 'main' } }];
      return json(route, 201, state.pulls[0]);
    }
    if (m === 'POST' && p === '/repos/acme/decks/pulls/7/comments') {
      state.review = body;
      return json(route, 201, { id: 99, ...body, user: { login: 'octo' }, html_url: 'https://github.com/acme/decks/pull/7#discussion_r99', pull_request_url: 'https://api.github.com/repos/acme/decks/pulls/7', created_at: '2026-11-09T12:00:00Z' });
    }
    return json(route, 404, { message: `fake GitHub has no ${m} ${p}` });
  });
}

async function openDeck(hash = '#1', opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  const state = { calls: [], pulls: [], prFiles: [], contents: {}, reviewComments: opts.reviewComments || [] };
  await fakeGitHub(page, state);
  await page.goto(`${base}/example/${opts.query || ''}${hash}`);
  await page.waitForFunction(() => window.sealSlides && document.querySelector('#count').textContent.includes('/'));
  return { page, context, errors, state };
}

const count = page => page.locator('#count').textContent();

// Edit mode asks for a token first; its text boxes open once the viewer's pull request has been read.
async function signIn(page) {
  await page.locator('#ed-token').fill('github_pat_' + 'x'.repeat(30));
  await page.locator('#editor .signin button').click();
  await page.locator('#editor footer').getByText('Signed in as octo').waitFor();
  await page.waitForFunction(() => !document.querySelector('#ed-source').readOnly);
}

test('navigation: keys, hash, marks, notes, sources and theme', async () => {
  const { page, context, errors } = await openDeck('#1');
  assert.equal(await count(page), '1 / 7');
  assert.equal(await page.locator('.slide.active h1').textContent(), 'Seal Slides');
  assert.ok(await page.locator('.slide.active .stage svg use').count() > 0, 'the title drawing places the seal');
  await page.keyboard.press('ArrowRight');
  assert.equal(await count(page), '2 / 7');
  assert.match(page.url(), /#2$/);
  await page.keyboard.press('End');
  assert.equal(await count(page), '7 / 7');
  assert.equal(await page.locator('.slide.active').getAttribute('data-status'), 'next');
  assert.equal(await page.locator('.slide.active .proofmarks').count(), 1);
  await page.keyboard.press('Home');
  assert.equal(await count(page), '1 / 7');
  await page.locator('#marks button').nth(3).click();
  assert.equal(await count(page), '4 / 7');
  assert.ok(await page.locator('.slide.active .stage svg path').count() > 3, 'the pipeline drawing is drawn');

  await page.keyboard.press('n');
  await page.locator('#notes-panel').waitFor();
  assert.match(await page.locator('#notes-panel .script').textContent(), /When a slide needs motion/);
  assert.match(await page.locator('#notes-panel .np-h').textContent(), /Say it in about 0:25 · \d+ words · sources: S/);
  assert.ok(!/engine\/draw\.js/.test(await page.locator('#notes-panel').textContent()), 'sources stay out of the script');

  // S swaps the script for this slide's sources.
  await page.keyboard.press('s');
  await page.locator('#sources-panel').waitFor();
  assert.ok(await page.locator('#notes-panel').isHidden());
  assert.match(await page.locator('#sources-panel').textContent(), /Sources for slide 4.*engine\/draw\.js/s);
  await page.keyboard.press('ArrowLeft');
  assert.match(await page.locator('#sources-panel').textContent(), /Sources for slide 3.*engine\/loader\.js/s);
  await page.locator('#sources-panel button', { hasText: 'all slides' }).click();
  await page.locator('#sources-view').waitFor();
  assert.equal(await page.locator('#sources-view > ol > li').count(), 7);
  assert.equal(await page.locator('#sources-view a[href="https://github.com/bitswell-hq/seal-slides#readme"]').count(), 1);
  await page.locator('#sources-view .src-title button').nth(1).click();
  assert.equal(await count(page), '2 / 7');
  assert.ok(await page.locator('#sources-view').isHidden());

  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.keyboard.press('t');
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(before, after, 'T switches the theme');

  await page.goto(`${base}/example/#5`);
  await page.waitForFunction(() => document.querySelector('#count').textContent === '5 / 7');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a drawing module is imported only from inside the deck folder', async () => {
  const { page, context, errors } = await openDeck('#1');
  const got = await page.evaluate(async () => {
    const { loadDeckDrawing, drawUrl } = await import(new URL('../engine/runtime.js', location.href).href);
    const refused = p => { try { return drawUrl(p); } catch (e) { return e.message; } };
    return {
      inside: typeof (await loadDeckDrawing('animations/dial.js')).draw,
      real: (await loadDeckDrawing('../engine/draw.js')).error,
      urls: ['%2e%2e/%2e%2e/other/x.js', '..\\engine\\draw.js', '/engine/draw.js', '\\\\evil.example\\x.js', 'https://evil.example/x.js'].map(refused),
    };
  });
  assert.equal(got.inside, 'function');
  assert.match(got.real, /outside the deck folder/);
  for (const m of got.urls) assert.match(m, /outside the deck folder/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the editor is created once when it is opened twice while it loads', async () => {
  const { page, context, errors } = await openDeck('#1');
  await page.evaluate(() => { const b = document.getElementById('edit-btn'); b.click(); b.click(); });
  await page.locator('#editor').first().waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#editor').count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('#editor header button').click();
  assert.ok(await page.locator('#editor').isHidden());
  assert.deepEqual(errors, []);
  await context.close();
});

test('portrait windows get the portrait drawing', async () => {
  const { page, context, errors } = await openDeck('#4', { viewport: { width: 420, height: 860 } });
  assert.equal(await page.locator('.slide.active .stage svg').getAttribute('viewBox'), '0 0 800 1240');
  assert.deepEqual(errors, []);
  await context.close();
});

test('read-only viewers see review comments of open pull requests', async () => {
  const reviewComments = [{ id: 5, path: 'decks/example/slides/02-folder.md', line: 18, body: 'Is the tree up to date?', user: { login: 'reviewer' }, html_url: 'https://github.com/acme/decks/pull/3#r5', pull_request_url: 'https://api.github.com/repos/acme/decks/pulls/3', created_at: '2026-11-01T10:00:00Z' }];
  const { page, context, state } = await openDeck('#2', { reviewComments });
  state.pulls = [{ number: 3 }];
  await page.reload();
  await page.locator('#comments-btn:not([hidden])').waitFor();
  assert.equal(await page.locator('#comments-btn .badge').textContent(), '1');
  assert.ok(state.calls.every(c => c.auth === null), 'no token is needed to read');
  await page.locator('#comments-btn').click();
  await page.locator('#panel-comments .comment').waitFor();
  assert.match(await page.locator('#panel-comments .comment').textContent(), /reviewer.*line 18.*pull request #3.*Is the tree up to date\?/s);
  await context.close();
});

test('edit mode: live preview, script edits, saving and a line comment', async () => {
  const { page, context, errors, state } = await openDeck('#3');
  await page.keyboard.press('e');
  await page.locator('#editor').waitFor();
  const src = page.locator('#ed-source');
  assert.match(await src.inputValue(), /^---\ntitle: A slide is a Markdown file/);

  // Nothing can be typed before signing in, with a token kept in memory only.
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ed-token');
  assert.deepEqual(await page.evaluate(() => ['ed-source', 'ed-script', 'ed-sources', 'ed-drawing'].map(id => document.getElementById(id).readOnly)), [true, true, true, true]);
  await signIn(page);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], 'the token is stored nowhere');

  // Live preview of the Markdown.
  await src.fill((await src.inputValue()).replace('title: A slide is a Markdown file', 'title: Edited in the browser'));
  await page.waitForFunction(() => document.querySelector('.slide.active h2').textContent === 'Edited in the browser');
  assert.match(await page.locator('#editor .changed').textContent(), /decks\/example\/slides\/03-markdown\.md/);

  // A YAML error keeps the last good slide and says where.
  await src.fill((await src.inputValue()).replace('status: now', 'status: [now'));
  await page.waitForFunction(() => /not valid YAML/.test(document.querySelector('#editor .err').textContent));
  assert.equal(await page.locator('.slide.active h2').textContent(), 'Edited in the browser');
  await src.fill((await src.inputValue()).replace('status: [now', 'status: now'));
  await page.waitForFunction(() => document.querySelector('#editor .err').textContent === '');

  // The script tab writes the notes back into the front matter.
  await page.locator('#tab-script').click();
  await page.locator('#ed-script').fill('A new first line.\n\nA second line.');
  await page.locator('#tab-source').click();
  assert.match(await src.inputValue(), /notes: \|\n {2}A new first line\.\n\n {2}A second line\.\nsources:/);
  await page.locator('#tab-sources').click();
  await page.locator('#ed-sources').fill('One source\n[Two](https://example.org)');
  await page.locator('#tab-source').click();
  assert.match(await src.inputValue(), /sources:\n {2}- "One source"\n {2}- "\[Two\]\(https:\/\/example\.org\)"\n---/);

  await page.locator('#ed-message').fill('Retitle slide 3');
  await page.locator('#editor footer button', { hasText: 'Save to GitHub' }).click();
  await page.locator('#editor footer .result a', { hasText: 'pull request #7' }).waitFor();
  assert.match(state.branch, /^seal-slides\/example\/octo-\d{8}-\d{6}Z$/);
  assert.equal(state.tree.tree[0].path, 'decks/example/slides/03-markdown.md');
  assert.match(state.tree.tree[0].content, /title: Edited in the browser/);
  assert.equal(state.calls.find(c => c.p === '/repos/acme/decks/pulls' && c.m === 'POST').body.title, 'Retitle slide 3');
  assert.match(await page.locator('#editor .changed').textContent(), /No changes/);

  // Select text on the slide and comment on it: a review comment on that line.
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#count').textContent === '4 / 7');
  await page.keyboard.press('ArrowLeft');
  state.prFiles = [{ filename: 'decks/example/slides/03-markdown.md', status: 'modified', patch: '@@ -1,40 +1,40 @@\n' + Array.from({ length: 40 }, (_, i) => ' line ' + (i + 1)).join('\n') }];
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('.slide.active .md li')].find(l => l.textContent.includes('status picks its marks'));
    const r = document.createRange();
    r.selectNodeContents(li);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await page.locator('#sel-comment:not([hidden])').click();
  await page.locator('#panel-comments:not([hidden])').waitFor();
  const anchor = await page.locator('#panel-comments .anchor').textContent();
  const line = Number(/line (\d+)/.exec(anchor)[1]);
  const fileText = await src.inputValue();
  assert.match(fileText.split('\n')[line - 1], /\*\*status\*\* picks its marks/, 'the anchor is the line holding the selected text');
  await page.locator('#ed-comment').fill('Say which marks.');
  await page.locator('#panel-comments button', { hasText: 'Post comment' }).click();
  await page.locator('#panel-comments .result a', { hasText: 'pull request #7' }).waitFor();
  assert.equal(state.review.line, line);
  assert.equal(state.review.path, 'decks/example/slides/03-markdown.md');
  assert.equal(state.review.body, 'Say which marks.');
  assert.match(await page.locator('#panel-comments .comments').textContent(), /Say which marks\./);

  await page.locator('#editor header button').click();
  assert.ok(await page.locator('#editor').isHidden());
  assert.deepEqual(errors, []);
  await context.close();
});

test('edit mode: a slide change while typing gives the editor the new slide\'s text', async () => {
  const { page, context, errors } = await openDeck('#3');
  await page.keyboard.press('e');
  await page.locator('#editor').waitFor();
  const src = page.locator('#ed-source');
  await signIn(page);
  await src.fill((await src.inputValue()).replace('title: A slide is a Markdown file', 'title: Slide three, edited'));
  await page.evaluate(() => { location.hash = '#4'; });
  await page.waitForFunction(() => document.querySelector('#count').textContent === '4 / 7');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ed-source', 'the textarea kept the focus');
  const four = await src.inputValue();
  assert.match(four, /^---\ntitle: Some slides are drawn/);
  await page.keyboard.type('x');
  const changed = await page.evaluate(() => window.sealSlides.editor.changed().map(f => [f.path, f.text]));
  assert.equal(changed.length, 2);
  assert.equal(changed[0][0], 'decks/example/slides/03-markdown.md');
  assert.match(changed[0][1], /title: Slide three, edited/);
  assert.equal(changed[1][0], 'decks/example/slides/04-drawn.md');
  assert.match(changed[1][1], /^---\ntitle: Some slides are drawn/);
  assert.equal(changed[1][1].length, four.length + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('edit mode: signing in loads the viewer\'s open pull request, and the next save builds on it', async () => {
  const { page, context, errors, state } = await openDeck('#3');
  await page.keyboard.press('e');
  await page.locator('#editor').waitFor();
  const src = page.locator('#ed-source');
  const file = 'decks/example/slides/03-markdown.md';
  const first = (await src.inputValue()).replace('title: A slide is a Markdown file', 'title: Saved earlier');
  state.pulls = [{ number: 7, html_url: 'https://github.com/acme/decks/pull/7', user: { login: 'octo' }, head: { ref: 'seal-slides/example/octo-1', sha: 'pr-head', repo: { full_name: 'acme/decks', name: 'decks', owner: { login: 'acme' } } }, base: { ref: 'main' } }];
  state.prFiles = [{ filename: file, status: 'modified' }];
  state.contents[file] = first;

  await signIn(page);
  await page.locator('#editor footer .hint a', { hasText: 'pull request #7' }).waitFor();
  assert.equal(await src.inputValue(), first);
  await page.waitForFunction(() => document.querySelector('.slide.active h2').textContent === 'Saved earlier');
  assert.match(await page.locator('#editor .changed').textContent(), /No changes/);

  await src.fill(first.replace('title: Saved earlier', 'title: Saved twice'));
  await page.locator('#editor footer button', { hasText: 'Save to GitHub' }).click();
  await page.locator('#editor footer .result a', { hasText: 'pull request #7' }).waitFor();
  assert.match(await page.locator('#editor footer .result').textContent(), /added to pull request #7/);
  assert.match(state.tree.tree[0].content, /title: Saved twice/);
  assert.ok(!state.calls.some(c => c.m === 'POST' && c.p === '/repos/acme/decks/pulls'), 'no second pull request');

  // The pull request changes one file under the viewer: nothing is saved, their text can be copied,
  // and loading the newer version of that file keeps their edit to another.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const theirs = first.replace('title: Saved earlier', 'title: Changed elsewhere');
  const yours = first.replace('title: Saved earlier', 'title: Typed meanwhile') + '\nTyped after the conflict.';
  state.contents[file] = theirs;
  state.tree = null;
  await page.evaluate(() => { location.hash = '#5'; });
  await page.waitForFunction(() => document.querySelector('#count').textContent === '5 / 7');
  const other = (await src.inputValue()) + '\nAn edit to another slide.\n';
  await src.fill(other);
  await page.evaluate(() => { location.hash = '#3'; });
  await page.waitForFunction(() => document.querySelector('#count').textContent === '3 / 7');
  await src.fill(yours.slice(0, -1));
  await page.locator('#editor footer button', { hasText: 'Save to GitHub' }).click();
  await page.locator('#editor footer .result button', { hasText: 'Copy my text' }).waitFor();
  await src.focus();
  await page.keyboard.type(yours.slice(-1));
  await page.locator('#editor footer .result button', { hasText: 'Copy my text' }).click();
  await page.locator('#editor footer .result button', { hasText: 'Copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), yours);
  assert.match(await page.locator('#editor footer .result').textContent(), /03-markdown\.md changed in pull request #7 since the editor loaded it/);
  assert.equal(state.tree, null, 'nothing was committed');
  assert.equal(await src.inputValue(), yours);
  await page.locator('#editor footer').getByText('holds a newer 03-markdown.md').waitFor();
  await page.locator('#editor footer .result button', { hasText: 'Load the newer version' }).click();
  await page.waitForFunction(() => document.querySelector('.slide.active h2').textContent === 'Changed elsewhere');
  assert.equal(await src.inputValue(), theirs);
  assert.deepEqual(await page.evaluate(() => window.sealSlides.editor.changed().map(f => [f.path, f.text])), [['decks/example/slides/05-edit.md', other]]);
  await page.locator('#editor footer button', { hasText: 'Save to GitHub' }).click();
  await page.locator('#editor footer .result a', { hasText: 'pull request #7' }).waitFor();
  assert.deepEqual(state.tree.tree.map(x => [x.path, x.content]), [['decks/example/slides/05-edit.md', other]]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('edit mode: a drawing module is never loaded from the viewer\'s open pull request', async () => {
  const { page, context, errors, state } = await openDeck('#1');
  const seals = () => page.locator('.slide.active .stage svg use').count();
  await page.keyboard.press('e');
  await page.locator('#editor').waitFor();
  const file = 'decks/example/animations/dial.js';
  state.pulls = [{ number: 7, html_url: 'https://github.com/acme/decks/pull/7', user: { login: 'octo' }, head: { ref: 'seal-slides/example/octo-1', sha: 'pr-head', repo: { full_name: 'acme/decks', name: 'decks', owner: { login: 'acme' } } }, base: { ref: 'main' } }];
  state.prFiles = [{ filename: file, status: 'modified' }];
  state.contents[file] = 'window.ranFromBranch = true;\nexport default { viewBox: [\'0 0 800 800\', \'0 0 800 800\'], draw(c) { c.circle(400, 400, 100, { k: \'now\', w: 1 }); } };\n';

  // The Drawing tab starts from the published module, and nothing offers the branch's.
  await signIn(page);
  await page.locator('#tab-drawing').click();
  const draw = page.locator('#ed-drawing');
  await page.waitForFunction(() => /The title drawing/.test(document.querySelector('#ed-drawing').value));
  assert.equal(await draw.evaluate(t => t.readOnly), false);
  assert.equal(await page.locator('#panel-drawing button').count(), 1, 'Redraw is the only button');
  assert.ok(await seals() > 0, 'the published drawing is on the slide');
  assert.ok(!state.calls.some(c => c.p.includes('/contents/')), 'the branch\'s module was not fetched');

  // An edit over a module the pull request also changes is a conflict; the branch's module still does not run.
  await draw.fill((await draw.inputValue()) + '\n// mine\n');
  await page.locator('#tab-source').click();
  const src = page.locator('#ed-source');
  await src.fill((await src.inputValue()).replace('title: Seal Slides', 'title: Seal Slides, edited'));
  await page.locator('#editor footer button', { hasText: 'Save to GitHub' }).click();
  await page.locator('#editor footer .result button', { hasText: 'Copy my text' }).waitFor();
  assert.match(await page.locator('#editor footer .result').textContent(), /dial\.js differs in pull request #7.*never loaded from a pull request/);
  assert.deepEqual(await page.locator('#editor footer .result button').allTextContents(), ['Copy my text', 'Drop my change to this file'], 'no button loads the branch\'s version');
  assert.equal(state.tree, undefined, 'nothing was committed');
  assert.match(await draw.inputValue(), /\/\/ mine\n$/);

  // Dropping that one change lets the edit to the slide be saved.
  await page.locator('#editor footer .result button', { hasText: 'Drop my change to this file' }).click();
  await page.waitForFunction(() => /^Changed: decks\/example\/slides\/01-title\.md$/.test(document.querySelector('#editor .changed').textContent));
  await page.locator('#editor footer button', { hasText: 'Save to GitHub' }).click();
  await page.locator('#editor footer .result a', { hasText: 'pull request #7' }).waitFor();
  assert.deepEqual(state.tree.tree.map(x => x.path), ['decks/example/slides/01-title.md']);
  assert.match(state.tree.tree[0].content, /title: Seal Slides, edited/);
  assert.ok(await seals() > 0);
  assert.equal(await page.evaluate(() => window.ranFromBranch), undefined);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a tool whose module fails to load says so and loads on the next try', async () => {
  const { page, context } = await openDeck('#1');
  let fail = true;
  await page.route('**/engine/editor.js', route => (fail ? route.abort() : route.continue()));
  await page.keyboard.press('e');
  await page.locator('#tool-msg:not([hidden])').waitFor();
  assert.match(await page.locator('#tool-msg').textContent(), /Could not load the editor/);
  assert.equal(await page.locator('#editor').count(), 0);
  await page.locator('#tool-msg button').click();
  assert.ok(await page.locator('#tool-msg').isHidden(), 'the message can be closed');
  await page.keyboard.press('e');
  await page.locator('#tool-msg:not([hidden])').waitFor();
  fail = false;
  await page.keyboard.press('e');
  await page.locator('#editor').waitFor();
  assert.ok(await page.locator('#tool-msg').isHidden());
  await context.close();
});

test('deck HTML cannot run script in the page or get a handle on its window', async () => {
  const { page, context, errors } = await openDeck('#1');
  const got = await page.evaluate(async () => {
    const { deckHtml, scriptBlock } = await import(new URL('../engine/runtime.js', location.href).href);
    const html = [
      '<iframe id="f" name="top2" src="/other/x.html" srcdoc="<script src=/other/x.js></script>" onload="x()"></iframe>',
      '<iframe id="g" src="javascript:alert(1)" sandbox="allow-scripts allow-same-origin"></iframe>',
      '<iframe id="perm" src="https://example.org/x.html" allow="microphone; camera; display-capture" allowfullscreen allowpaymentrequest></iframe>',
      '<object data="/other/x.html"></object><embed src="/other/x.svg"><script src="/other/x.js"></script>',
      '<base href="/other/"><meta http-equiv="refresh" content="0;url=/other/"><link rel="stylesheet" href="/other/x.css">',
      '<form action="/other/"><button id="inform" formaction="/other/">go</button></form><template><p id="tpl">t</p></template>',
      '<a id="js" href="javascript:alert(1)">a</a><a id="tab" href="java\tscript:alert(1)">b</a><a id="data" href="data:text/html,x">c</a>',
      '<a id="named" href="/other/x.html" target="w" rel="opener">d</a><a id="plain" href="https://example.org/x">e</a><a id="rel" href="assets/x.pdf">f</a><a id="mail" href="mailto:a@example.org">g</a>',
      '<img id="img" name="body" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="x()"><img id="img2" src="assets/photo.png" alt="p">',
      '<button id="btn" formaction="javascript:alert(1)" onclick="x()">h</button><p id="keep" class="lead" style="color:red" data-line="3">kept <em>text</em></p>',
      '<svg id="svg"><a id="sa" xlink:href="javascript:alert(1)"><text>i</text></a><use id="u1" href="data:image/svg+xml,x#a"/><use id="u2" href="#seal-A"/>',
      '<set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="javascript:alert(1)"/><animate id="ok" attributeName="opacity" values="0;1"/>',
      '<foreignObject><iframe id="fo" src="/other/y.html"></iframe></foreignObject><script>window.ranInline = 1</script></svg>',
    ].join('');
    const div = document.createElement('div');
    div.append(deckHtml(html));
    document.body.append(div);
    const at = (id, ...names) => { const e = div.querySelector('#' + id); return e ? names.map(n => e.getAttribute(n)) : 'missing'; };
    const out = {
      dropped: div.querySelectorAll('object, embed, script, base, meta, link, form, template, set, #inform, #tpl').length,
      animates: Array.from(div.querySelectorAll('animate'), e => e.id),
      handlers: Array.from(div.querySelectorAll('*')).flatMap(e => e.getAttributeNames().filter(n => /^on|^srcdoc$|^formaction$/i.test(n))),
      f: at('f', 'sandbox', 'src', 'name'), perm: at('perm', 'sandbox', 'src', 'allow', 'allowfullscreen', 'allowpaymentrequest'), g: at('g', 'sandbox', 'src'), fo: at('fo', 'sandbox'),
      js: at('js', 'href'), tab: at('tab', 'href'), data: at('data', 'href'), sa: at('sa', 'xlink:href'),
      named: at('named', 'href', 'target', 'rel'), plain: at('plain', 'href', 'target', 'rel'), rel: at('rel', 'href'), mail: at('mail', 'href'),
      img: at('img', 'src', 'name'), img2: at('img2', 'src', 'alt'), u1: at('u1', 'href'), u2: at('u2', 'href'),
      keep: [div.querySelector('#keep').outerHTML],
      script: scriptBlock(['say <iframe src="/other/z.html"></iframe> **this**']).innerHTML,
      ran: window.ranInline,
    };
    div.remove();
    return out;
  });
  const SANDBOX = 'allow-scripts allow-popups allow-presentation';
  assert.equal(got.dropped, 0);
  assert.deepEqual(got.animates, ['ok']);
  assert.deepEqual(got.handlers, []);
  assert.deepEqual(got.f, [SANDBOX, '/other/x.html', null]);
  assert.deepEqual(got.g, [SANDBOX, null]);
  assert.deepEqual(got.perm, [SANDBOX, 'https://example.org/x.html', null, null, null], 'no permission of the page is delegated to a frame');
  assert.deepEqual(got.fo, [SANDBOX]);
  assert.deepEqual([got.js, got.tab, got.data, got.sa], [[null], [null], [null], [null]]);
  assert.deepEqual(got.named, ['/other/x.html', '_blank', 'noopener noreferrer']);
  assert.deepEqual(got.plain, ['https://example.org/x', null, 'noopener noreferrer']);
  assert.deepEqual([got.rel, got.mail], [['assets/x.pdf'], ['mailto:a@example.org']]);
  assert.deepEqual(got.img, ['data:image/gif;base64,R0lGODlhAQABAAAAACw=', null]);
  assert.deepEqual(got.img2, ['assets/photo.png', 'p']);
  assert.deepEqual([got.u1, got.u2], [[null], ['#seal-A']]);
  assert.deepEqual(got.keep, ['<p id="keep" class="lead" style="color:red" data-line="3">kept <em>text</em></p>']);
  assert.equal(got.script, `<p>say <iframe src="/other/z.html" sandbox="${SANDBOX}"></iframe> <strong>this</strong></p>`);
  assert.equal(got.ran, undefined);
  // The page's Content Security Policy already refuses the handlers when the text is parsed, and says so.
  assert.deepEqual(errors.filter(e => !/^Executing inline event handler violates/.test(e)), []);
  await context.close();
});

test('edit mode: a frame and a link in a slide loaded from the viewer\'s pull request are fenced in', async () => {
  const { page, context, state } = await openDeck('#3');
  await page.keyboard.press('e');
  await page.locator('#editor').waitFor();
  const file = 'decks/example/slides/03-markdown.md';
  const built = await page.locator('#ed-source').inputValue();
  state.pulls = [{ number: 7, html_url: 'https://github.com/acme/decks/pull/7', user: { login: 'octo' }, head: { ref: 'seal-slides/example/octo-1', sha: 'pr-head', repo: { full_name: 'acme/decks', name: 'decks', owner: { login: 'acme' } } }, base: { ref: 'main' } }];
  state.prFiles = [{ filename: file, status: 'modified' }];
  state.contents[file] = built.replace('  - "engine/loader.js"', '  - "<a href=\\"/other/x.html\\" target=\\"w\\" rel=\\"opener\\">a source</a>"') +
    '\n<iframe src="/other/x.html" srcdoc="<script src=/other/x.js></script>"></iframe>\n\n<object data="/other/x.html"></object>\n';
  await signIn(page);
  const frame = page.locator('.slide.active .md iframe');
  await frame.waitFor({ state: 'attached' });
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-popups allow-presentation');
  assert.equal(await frame.getAttribute('srcdoc'), null);
  assert.equal(await page.locator('.slide.active object').count(), 0);
  await page.locator('#editor header button').click();
  await page.keyboard.press('s');
  const a = page.locator('#sources-panel a', { hasText: 'a source' });
  await a.waitFor();
  assert.deepEqual([await a.getAttribute('target'), await a.getAttribute('rel')], ['_blank', 'noopener noreferrer']);
  await context.close();
});

test('edit mode: no sign-in in a page another page opened or framed', async () => {
  const { page, context, errors, state } = await openDeck('#3');
  const refused = async target => {
    await target.locator('#editor').waitFor();
    await target.locator('#editor .signin').getByText('Signing in is off here').waitFor();
    assert.equal(await target.locator('#ed-token').count(), 0, 'no token field');
    assert.equal(await target.locator('#ed-source').evaluate(t => t.readOnly), true, 'nothing can be edited');
  };
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate(() => { window.open(location.pathname + '?edit=1#3'); }),
  ]);
  await refused(popup);

  await page.goto(`${base}/`);
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.src = 'example/?edit=1#3';
    f.style.cssText = 'width:1200px;height:800px';
    document.body.append(f);
  });
  await refused(page.frameLocator('iframe'));
  assert.ok(state.calls.every(c => c.auth === null), 'no token was sent');
  assert.deepEqual(errors, []);
  await context.close();
});

// Decode frames of a recorded file in the page and compare each with every
// slide as the recorder paints it: the share of pixels that differ clearly.
async function inspectVideo(page, file, type, probes, area) {
  return page.evaluate(async ({ b64, type, probes, area }) => {
    const { paintAll } = await import(new URL('../engine/recorder.js', location.href).href);
    const snaps = (await paintAll(window.sealSlides)).map(c => c.getContext('2d').getImageData(0, 0, 1920, 1080).data);
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(new Blob([bytes], { type }));
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('cannot decode the video')); });
    const out = { w: v.videoWidth, h: v.videoHeight, duration: v.duration, frames: [] };
    const c = document.createElement('canvas');
    c.width = 1920; c.height = 1080;
    const g = c.getContext('2d', { willReadFrequently: true });
    for (const at of probes) {
      v.currentTime = at;
      await new Promise(res => { v.onseeked = res; });
      g.drawImage(v, 0, 0, 1920, 1080);
      const f = g.getImageData(0, 0, 1920, 1080).data;
      const differ = (p, [x0, y0, w, h]) => {
        let off = 0;
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
          const k = (y * 1920 + x) * 4;
          if (Math.max(Math.abs(p[k] - f[k]), Math.abs(p[k + 1] - f[k + 1]), Math.abs(p[k + 2] - f[k + 2])) > 64) off++;
        }
        return off / (w * h);
      };
      out.frames.push({ whole: snaps.map(p => differ(p, [0, 0, 1920, 1080])), panel: snaps.map(p => differ(p, area)) });
    }
    return out;
  }, { b64: file.toString('base64'), type, probes, area });
}

test('the recorder saves a 1920×1080 video of the slides with microphone audio', async () => {
  const { page, context, errors } = await openDeck('#1');
  const recorded = page.evaluate(() => new Promise(r => addEventListener('seal-slides:recording', e => r(e.detail), { once: true })));
  await page.keyboard.press('r');
  await page.locator('#rec-count:not([hidden])').waitFor();
  await page.locator('#rec-panel:not([hidden])').waitFor({ timeout: 20000 });
  assert.ok(await page.locator('#rec-count').isHidden(), 'the countdown is over');
  assert.equal(await page.locator('#record-btn').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#rp-script').textContent(), /This is Seal Slides/);
  assert.equal(await page.locator('#rec-panel .rp-lim').textContent(), '/ 3:00');
  assert.match(await page.locator('#rp-cur').textContent(), /Slide 1 of 7 · 0:0\d of about 0:15/);
  assert.match(await page.locator('#rec-panel .rp-next').textContent(), /Next: One folder per deck/);
  // Where the panel sits, in video pixels.
  const area = await page.evaluate(() => {
    const r = document.getElementById('rec-panel').getBoundingClientRect(), k = 1920 / innerWidth;
    return [r.left, r.top, r.width, r.height].map(n => Math.round(n * k));
  });
  await page.waitForTimeout(1500);
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator('#rp-script').textContent(), /A deck is one folder/);
  await page.waitForTimeout(800);
  await page.keyboard.press('p');
  assert.equal(await page.locator('html').getAttribute('data-recording'), 'paused');
  assert.equal(await page.locator('#rp-pause').textContent(), 'Resume (P)');
  const pausedAt = await page.locator('#rp-time').textContent();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#rp-time').textContent(), pausedAt, 'the clock stops while paused');
  await page.keyboard.press('p');
  assert.equal(await page.locator('html').getAttribute('data-recording'), 'recording');
  await page.waitForTimeout(1000);
  const download = page.waitForEvent('download');
  await page.keyboard.press('r');
  const d = await download;
  const detail = await recorded;
  assert.match(d.suggestedFilename(), /^example-\d{8}-\d{4}\.(mp4|webm)$/);
  assert.deepEqual([detail.width, detail.height], [1920, 1080]);
  assert.ok(detail.seconds > 2.5 && detail.seconds < 6, `paused time is left out (${detail.seconds}s)`);
  const file = await readFile(await d.path());
  assert.equal(file.length, detail.size);
  const saved = await page.locator('#rec-msg').textContent();
  if (detail.type.startsWith('video/mp4')) {
    // MP4 holds AAC audio where the browser has an AAC encoder and Opus where it has none (Chromium on Linux).
    assert.equal(file.subarray(4, 8).toString('latin1'), 'ftyp');
    const aac = file.includes('mp4a'), opus = file.includes('Opus');
    assert.ok(aac || opus, 'an AAC or Opus audio track');
    if (aac) assert.match(saved, /MP4 \(H\.264 and AAC\)/, 'the message names the AAC track');
    else assert.doesNotMatch(saved, /AAC/, 'the message claims no AAC track the file does not have');
  } else {
    assert.ok(file.includes('A_OPUS'), 'an Opus audio track');
    assert.match(saved, /WebM \(VP[89] and Opus\)/);
  }
  assert.match(saved, /Saved example-.*1920×1080.*nothing was uploaded/);
  assert.ok(await page.locator('#rec-panel').isHidden());
  assert.equal(await page.locator('html').getAttribute('data-recording'), null);

  // The first frames are the title slide and the last ones slide 2, as painted,
  // with nothing of the presenter panel (a fifth of the frame) over them.
  const v = await inspectVideo(page, file, detail.type, [0.3, detail.seconds - 0.4], area);
  assert.deepEqual([v.w, v.h], [1920, 1080]);
  const [first, last] = v.frames;
  const pct = x => (x * 100).toFixed(2) + '%';
  assert.ok(first.whole[0] < 0.005, `the first frame is slide 1 (${pct(first.whole[0])} differ)`);
  assert.ok(last.whole[1] < 0.005, `the last frame is slide 2 (${pct(last.whole[1])} differ)`);
  assert.ok(first.whole[1] > 0.02 && last.whole[0] > 0.02, 'the two slides look different');
  assert.ok(first.panel[0] < 0.005 && last.panel[1] < 0.005, `the panel's area shows the slide, not the panel (${pct(first.panel[0])}, ${pct(last.panel[1])})`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a blocked microphone records nothing and says why; Escape cancels the countdown', async () => {
  const { page, context } = await openDeck('#1');
  await page.evaluate(() => {
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    window.blockMic = true;
    md.getUserMedia = c => (window.blockMic ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : orig(c));
  });
  await page.keyboard.press('r');
  await page.locator('#rec-msg.err').waitFor();
  assert.match(await page.locator('#rec-msg').textContent(), /microphone was blocked, so nothing was recorded/);
  assert.equal(await page.locator('html').getAttribute('data-recording'), null);
  await page.evaluate(() => { window.blockMic = false; });
  await page.keyboard.press('r');
  await page.locator('#rec-count b').waitFor({ timeout: 20000 });
  await page.keyboard.press('Escape');
  await page.locator('#rec-msg').getByText('Recording cancelled; nothing was saved.').waitFor();
  assert.ok(await page.locator('#rec-count').isHidden());
  assert.equal(await page.locator('html').getAttribute('data-recording'), null);
  await context.close();
});

test('each painted slide matches the slide as the browser shows it at 1920×1080', async () => {
  const { page, context, errors } = await openDeck('#1', { viewport: { width: 1920, height: 1080 } });
  await page.addStyleTag({ content: '.chrome { display: none !important; }' });
  const shots = await page.evaluate(async () => {
    const { paintAll } = await import(new URL('../engine/recorder.js', location.href).href);
    const canvases = await paintAll(window.sealSlides);
    return canvases.map(c => c.toDataURL('image/png'));
  });
  assert.equal(shots.length, 7);
  for (let i = 0; i < shots.length; i++) {
    await page.evaluate(n => window.sealSlides.go(n), i);
    await page.waitForTimeout(150);
    const live = (await page.screenshot()).toString('base64');
    const diff = await page.evaluate(async ({ a, b }) => {
      const load = async src => { const im = new Image(); im.src = src; await im.decode(); const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 1920, 1080); return g.getImageData(0, 0, 1920, 1080).data; };
      const [p, q] = await Promise.all([load(a), load('data:image/png;base64,' + b)]);
      let off = 0;
      for (let k = 0; k < p.length; k += 4) if (Math.max(Math.abs(p[k] - q[k]), Math.abs(p[k + 1] - q[k + 1]), Math.abs(p[k + 2] - q[k + 2])) > 64) off++;
      return off / (p.length / 4);
    }, { a: shots[i], b: live });
    assert.ok(diff < 0.01, `slide ${i + 1}: ${(diff * 100).toFixed(2)}% of pixels differ from the live slide`);
  }
  assert.deepEqual(errors, []);
  await context.close();
});
