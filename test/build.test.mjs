import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build, repoInfo } from '../scripts/build.mjs';

const REPO = { owner: 'acme', name: 'decks', ref: 'main', sha: 'abc123', pr: null };

test('the example deck builds to a static site', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'seal-slides-build-'));
  try {
    const summary = await build({ outDir: out, repo: REPO });
    assert.deepEqual(summary.map(d => d.slug), ['example']);
    for (const f of ['index.html', '.nojekyll', 'engine/boot.js', 'engine/seal-slides.css', 'engine/vendor/marked.js', 'engine/vendor/js-yaml.js',
      'engine/vendor/marked.LICENSE.txt', 'engine/vendor/js-yaml.LICENSE.txt', 'example/index.html', 'example/animations/dial.js', 'example/animations/pipeline.js']) {
      assert.ok(existsSync(path.join(out, f)), f);
    }
    assert.ok(!existsSync(path.join(out, 'example/deck.md')), 'Markdown is embedded, not copied');
    assert.ok(!existsSync(path.join(out, 'example/slides')), 'slide files are embedded, not copied');
    const html = await readFile(path.join(out, 'example/index.html'), 'utf8');
    const data = JSON.parse(/<script type="application\/json" id="deck-data">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(data.slides.length, 7);
    assert.deepEqual(data.repo, REPO);
    assert.equal(data.deck.dir, 'decks/example');
    assert.equal(data.slides[0].file, 'decks/example/slides/01-title.md');
    // The CSP allows exactly the inline import map.
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1];
    const hash = createHash('sha256').update(map).digest('base64');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)[1].replace(/&#39;/g, "'");
    assert.ok(csp.includes(`script-src 'self' blob: 'sha256-${hash}'`), 'the CSP allows exactly the import map');
    assert.ok(csp.includes("connect-src 'self' https://api.github.com"));
    const root = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(root, /<a href="example\/">Seal Slides<\/a>/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('embedded deck text cannot close its script element', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seal-slides-decks-'));
  const out = path.join(dir, 'site');
  try {
    await mkdir(path.join(dir, 'decks', 'x', 'slides'), { recursive: true });
    await writeFile(path.join(dir, 'decks', 'x', 'deck.md'), '---\ntitle: X\n---\n');
    await writeFile(path.join(dir, 'decks', 'x', 'slides', '01.md'), '---\ntitle: "</script><script>alert(1)</script>"\n---\nbody\n');
    await build({ decksDir: path.join(dir, 'decks'), outDir: out, repo: null });
    const html = await readFile(path.join(out, 'x', 'index.html'), 'utf8');
    assert.equal(html.match(/<\/script>/g).length, 3, 'only the three real script elements close');
    assert.ok(html.includes('\\u003c/script>'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the build reports every broken slide with its file and line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seal-slides-decks-'));
  try {
    await mkdir(path.join(dir, 'decks', 'bad', 'slides'), { recursive: true });
    await writeFile(path.join(dir, 'decks', 'bad', 'deck.md'), '---\ntitle: Bad\n---\n');
    await writeFile(path.join(dir, 'decks', 'bad', 'slides', '01.md'), '---\ntitle: ok\nstatus: unknown\n---\n');
    await writeFile(path.join(dir, 'decks', 'bad', 'slides', '02.md'), '---\ntitle: ok\ndraw: animations/missing.js\nalt: x\n---\n');
    await assert.rejects(build({ decksDir: path.join(dir, 'decks'), outDir: path.join(dir, 'site') }), e => {
      assert.match(e.message, /01\.md:3: status "unknown"/);
      assert.match(e.message, /02\.md: draw "animations\/missing\.js" does not exist/);
      return true;
    });
    assert.ok(!existsSync(path.join(dir, 'site')), 'nothing is written when the build fails');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repository details come from flags, then the environment', () => {
  assert.deepEqual(repoInfo({ repo: 'a/b', ref: 'main', sha: 's', pr: '4' }, {}), { owner: 'a', name: 'b', ref: 'main', sha: 's', pr: 4 });
  assert.deepEqual(repoInfo({}, { SEAL_SLIDES_REPO: 'c/d', SEAL_SLIDES_REF: 'dev', SEAL_SLIDES_SHA: 't', SEAL_SLIDES_PR: '' }), { owner: 'c', name: 'd', ref: 'dev', sha: 't', pr: null });
  assert.throws(() => repoInfo({ repo: 'nope' }, {}), /owner\/name/);
  assert.throws(() => repoInfo({ repo: 'a/b', pr: 'x' }, {}), /--pr must be a number/);
});
