import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'js-yaml';
import {
  splitFrontMatter, fieldLines, parseSlide, parseDeck, parseCommentFile, formatCommentFile, loadDeck,
  sortSlideFiles, renderMarkdown, renderInline, setField, locate, linesOfRange, parseDuration, formatDuration,
  speakingSeconds, yamlScalar, LoaderError,
} from '../engine/loader.js';

const SLIDE = `---
title: Where the policy lives
status: now
duration: 0:20
notes: |
  First line read aloud.

  Second line, after a pause.
sources:
  - "[A paper](https://example.org/p), p. 4"
  - Another source
---
# Heading

Some **bold** text
on two lines.

- item one
- item two

\`\`\`js
const x = 1;
\`\`\`
`;

test('splitFrontMatter separates YAML from the body and reports the body line', () => {
  const fm = splitFrontMatter(SLIDE, 's.md');
  assert.equal(fm.data.title, 'Where the policy lives');
  assert.equal(fm.bodyStartLine, 13);
  assert.ok(fm.body.startsWith('# Heading'));
});

test('a file without front matter is all body', () => {
  const fm = splitFrontMatter('# Just text\n', 's.md');
  assert.deepEqual(fm.data, {});
  assert.equal(fm.bodyStartLine, 1);
});

test('CRLF line endings are accepted', () => {
  const s = parseSlide(SLIDE.replace(/\n/g, '\r\n'), 's.md');
  assert.equal(s.title, 'Where the policy lives');
  assert.deepEqual(s.notes, ['First line read aloud.', 'Second line, after a pause.']);
});

test('an unclosed front matter block is an error with the file name', () => {
  assert.throws(() => splitFrontMatter('---\ntitle: x\n', 'a.md'), e => e instanceof LoaderError && /a\.md:1: .*never closed/.test(e.message));
});

test('invalid YAML is reported at its file line', () => {
  assert.throws(() => parseSlide('---\ntitle: a\nnotes: [\n---\nbody\n', 'b.md'), e => e instanceof LoaderError && e.file === 'b.md' && /not valid YAML/.test(e.message));
});

test('parseSlide reads title, status, duration, script lines and sources', () => {
  const s = parseSlide(SLIDE, 'decks/x/slides/02.md');
  assert.equal(s.title, 'Where the policy lives');
  assert.equal(s.status, 'now');
  assert.equal(s.layout, 'default');
  assert.equal(s.duration, 20);
  assert.deepEqual(s.notes, ['First line read aloud.', 'Second line, after a pause.']);
  assert.deepEqual(s.sources, ['[A paper](https://example.org/p), p. 4', 'Another source']);
  assert.equal(s.draw, null);
});

test('parseSlide maps fields to their file lines', () => {
  const s = parseSlide(SLIDE, 's.md');
  assert.equal(s.lines.title, 2);
  assert.deepEqual(s.lines.notes, [6, 8]);
  assert.deepEqual(s.lines.sources, [10, 11]);
  assert.equal(s.lines.body, 13);
});

test('notes may also be a list or a single string', () => {
  assert.deepEqual(parseSlide('---\ntitle: t\nnotes:\n  - one\n  - two\n---\n', 's.md').notes, ['one', 'two']);
  assert.deepEqual(parseSlide('---\ntitle: t\nnotes: just one\n---\n', 's.md').notes, ['just one']);
  const s = parseSlide('---\ntitle: t\nnotes:\n  - one\n  - two\n---\n', 's.md');
  assert.deepEqual(s.lines.notes, [4, 5]);
});

test('a slide needs a title', () => {
  assert.throws(() => parseSlide('---\nstatus: now\n---\nbody\n', 'c.md'), /needs a title/);
});

test('unknown keys, statuses and layouts are rejected with their line', () => {
  assert.throws(() => parseSlide('---\ntitle: t\ncolour: red\n---\n', 'c.md'), e => e.line === 3 && /unknown slide key "colour"/.test(e.message));
  assert.throws(() => parseSlide('---\ntitle: t\nstatus: done\n---\n', 'c.md'), /status "done" is not one of/);
  assert.throws(() => parseSlide('---\ntitle: t\nlayout: grid\n---\n', 'c.md'), /layout "grid"/);
});

test('draw must stay inside the deck folder and needs alt text', () => {
  assert.throws(() => parseSlide('---\ntitle: t\ndraw: ../x.js\nalt: a\n---\n', 'c.md'), /inside the deck folder/);
  assert.throws(() => parseSlide('---\ntitle: t\ndraw: https://e.org/x.js\nalt: a\n---\n', 'c.md'), /inside the deck folder/);
  assert.throws(() => parseSlide('---\ntitle: t\ndraw: /x.js\nalt: a\n---\n', 'c.md'), /inside the deck folder/);
  const forms = ['%2e%2e/%2e%2e/other/x.js', '%2E%2E/x.js', 'a/%2e%2e/%2e%2e/x.js', '\\\\evil.example\\x.js', '..\\x.js', 'a\\..\\..\\x.js', './x.js', 'a/./x.js', 'a/../x.js', 'a//x.js', '//e.org/x.js', 'x.js?y.js', 'x.js#y.js', 'a b/x.js', 'data:text/javascript,x.js', 'a/', '.js/'];
  for (const form of forms) {
    assert.throws(() => parseSlide(`---\ntitle: t\ndraw: ${JSON.stringify(form)}\nalt: a\n---\n`, 'c.md'), /inside the deck folder/, form);
  }
  for (const ok of ['x.js', 'animations/x.mjs', 'a/b-c/d_e.v2.js', '..a/x.js']) {
    assert.equal(parseSlide(`---\ntitle: t\ndraw: ${JSON.stringify(ok)}\nalt: a\n---\n`, 'c.md').draw, ok);
  }
  assert.throws(() => parseSlide('---\ntitle: t\ndraw: x.css\nalt: a\n---\n', 'c.md'), /\.js path/);
  assert.throws(() => parseSlide('---\ntitle: t\ndraw: animations/x.js\n---\n', 'c.md'), /needs alt text/);
  const s = parseSlide('---\ntitle: t\ndraw: animations/x.js\nalt: A drawing\n---\n', 'c.md');
  assert.equal(s.draw, 'animations/x.js');
  assert.equal(s.alt, 'A drawing');
});

test('durations are seconds or m:ss', () => {
  assert.equal(parseDuration(20), 20);
  assert.equal(parseDuration('20'), 20);
  assert.equal(parseDuration('20s'), 20);
  assert.equal(parseDuration('3:00'), 180);
  assert.equal(parseDuration('0:05'), 5);
  assert.equal(parseDuration(null), null);
  assert.throws(() => parseDuration('three minutes', 'd.md', 4), /d\.md:4: duration "three minutes"/);
  assert.throws(() => parseDuration('1:75'), /not seconds or m:ss/);
  assert.equal(formatDuration(180), '3:00');
  assert.equal(formatDuration(65.4), '1:05');
  assert.equal(formatDuration(null), '');
});

test('parseDeck reads statuses, seals, theme and duration', () => {
  const d = parseDeck('---\ntitle: Deck\nduration: 3:00\nstatuses:\n  now: works today\n  next: planned\nseals:\n  B: ' + 'ab'.repeat(32) + '\ntheme: dark\n---\nAbout.\n', 'deck.md');
  assert.equal(d.title, 'Deck');
  assert.equal(d.duration, 180);
  assert.deepEqual(d.statuses, { now: 'works today', next: 'planned' });
  assert.equal(d.seals.B, 'ab'.repeat(32));
  assert.ok(d.seals.A, 'a default seal is always there');
  assert.equal(d.theme, 'dark');
  assert.throws(() => parseDeck('---\nseals:\n  B: 1234\n---\n', 'deck.md'), /64 hex digits/);
  assert.throws(() => parseDeck('---\nstatuses:\n  done: x\n---\n', 'deck.md'), /"done" is not one of/);
  assert.throws(() => parseDeck('---\ntheme: blue\n---\n', 'deck.md'), /theme must be/);
});

test('loadDeck collects every error instead of stopping at the first', () => {
  const m = loadDeck({
    deck: { file: 'd/deck.md', raw: '---\ntitle: D\n---\n' },
    slides: [
      { file: 'd/slides/1.md', raw: '---\ntitle: ok\nduration: 10\n---\n' },
      { file: 'd/slides/2.md', raw: '---\nstatus: now\n---\n' },
      { file: 'd/slides/3.md', raw: '---\ntitle: t\nstatus: nope\n---\n' },
    ],
  });
  assert.equal(m.slides.length, 1);
  assert.equal(m.errors.length, 2);
  assert.match(m.errors[0].message, /2\.md/);
  assert.match(m.errors[1].message, /3\.md/);
});

test('the deck total is its duration, else the sum of slide durations', () => {
  const slides = [{ file: 'a.md', raw: '---\ntitle: a\nduration: 10\n---\n' }, { file: 'b.md', raw: '---\ntitle: b\nduration: 0:20\n---\n' }];
  assert.equal(loadDeck({ deck: { file: 'deck.md', raw: '---\ntitle: D\n---\n' }, slides }).total, 30);
  assert.equal(loadDeck({ deck: { file: 'deck.md', raw: '---\ntitle: D\nduration: 3:00\n---\n' }, slides }).total, 180);
});

test('a deck with no slides is an error', () => {
  const m = loadDeck({ deck: { file: 'deck.md', raw: '---\ntitle: D\n---\n' }, slides: [] });
  assert.match(m.errors[0].message, /no slides/);
});

test('slide files sort by name with numbers compared as numbers', () => {
  assert.deepEqual(sortSlideFiles(['10-end.md', '2-b.md', '01-a.md', '1b.md']), ['01-a.md', '1b.md', '2-b.md', '10-end.md']);
});

test('renderMarkdown tags each top-level block with its file lines', () => {
  const s = parseSlide(SLIDE, 's.md');
  const html = renderMarkdown(s.body, s.bodyStartLine);
  assert.match(html, /<h1 data-line="13" data-line-end="13">Heading<\/h1>/);
  assert.match(html, /<p data-line="15" data-line-end="16">Some <strong>bold<\/strong> text/);
  assert.match(html, /<ul data-line="18" data-line-end="19">/);
  assert.match(html, /<pre data-line="21" data-line-end="23"><code class="language-js">/);
});

test('raw HTML blocks pass through untagged and links keep reference definitions', () => {
  const html = renderMarkdown('<div class="cols">\n\ntext [ref][1]\n\n</div>\n\n[1]: https://example.org\n', 1);
  assert.match(html, /^<div class="cols">/);
  assert.match(html, /<a href="https:\/\/example.org">ref<\/a>/);
  assert.equal(renderInline('a [link](https://e.org) and `code`'), 'a <a href="https://e.org">link</a> and <code>code</code>');
});

test('setField replaces one key and leaves the other lines alone', () => {
  const out = setField(SLIDE, 'notes', ['New first line.', '', 'New second line.']);
  assert.ok(out.includes('notes: |\n  New first line.\n\n  New second line.\nsources:'));
  assert.ok(out.includes('title: Where the policy lives\nstatus: now\nduration: 0:20\n'));
  assert.ok(out.endsWith(SLIDE.slice(SLIDE.indexOf('---\n# Heading'))));
  const s = parseSlide(out, 's.md');
  assert.deepEqual(s.notes, ['New first line.', 'New second line.']);
});

test('setField emits YAML that parses back to the same values', () => {
  const tricky = ['Quotes "and" colons: here', '# not a comment', "it's", '- a dash', 'true', '12', '[brackets]', 'emoji ✓'];
  const withSources = setField(SLIDE, 'sources', tricky);
  assert.deepEqual(parseSlide(withSources, 's.md').sources, tricky);
  for (const t of ['Plain title', 'Title: with colon', 'yes', '3 things', "Don't", '[x]', 'a #b']) {
    const out = setField(SLIDE, 'title', t);
    assert.equal(parseSlide(out, 's.md').title, t, t);
    assert.equal(load(`k: ${yamlScalar(t)}`).k, t);
  }
  const notes = ['  leading spaces trimmed', 'ends with colon:', '- dash', '# hash'];
  assert.deepEqual(parseSlide(setField(SLIDE, 'notes', notes), 's.md').notes, notes.map(n => n.trim()));
});

test('a script line starting with # is replaced with the rest of the notes block', () => {
  const once = setField(SLIDE, 'notes', ['First line.', '#1 reason to care']);
  const f = fieldLines(once).notes;
  assert.equal(once.split('\n')[f.end - 1], '  #1 reason to care', 'the block ends on its last line');
  const twice = setField(once, 'notes', ['First line.', '#1 reason to care!']);
  assert.deepEqual(parseSlide(twice, 's.md').notes, ['First line.', '#1 reason to care!']);
  assert.deepEqual(parseSlide(setField(twice, 'notes', []), 's.md').notes, []);
  assert.deepEqual(parseSlide(twice, 's.md').sources, parseSlide(SLIDE, 's.md').sources);
});

test('setField adds a missing key before the closing fence and removes empty ones', () => {
  const added = setField('---\ntitle: t\n---\nbody\n', 'duration', 20);
  assert.equal(added, '---\ntitle: t\nduration: 20\n---\nbody\n');
  const removed = setField(SLIDE, 'sources', []);
  assert.ok(!removed.includes('sources:'));
  assert.deepEqual(parseSlide(removed, 's.md').notes, ['First line read aloud.', 'Second line, after a pause.']);
  assert.equal(setField('# no front matter\n', 'title', 'T'), '---\ntitle: T\n---\n# no front matter\n');
});

test('repo_dir is not a deck key', () => {
  assert.throws(() => parseDeck('---\ntitle: t\nrepo_dir: decks/x\n---\n', 'deck.md'), /unknown deck key "repo_dir"/);
});

test('fieldLines ignores indented keys and comments', () => {
  const f = fieldLines('---\ntitle: t\nstatuses:\n  now: a\n  # note\n  next: b\nduration: 3\n---\n');
  assert.deepEqual(Object.keys(f), ['title', 'statuses', 'duration']);
  assert.equal(f.statuses.line, 3);
  assert.equal(f.statuses.end, 6);
});

test('locate finds a rendered quote in Markdown source, ignoring markup', () => {
  assert.deepEqual(locate(SLIDE, 'bold text on two', 1), { line: 15, endLine: 16 });
  assert.deepEqual(locate(SLIDE, 'item two'), { line: 19, endLine: 19 });
  assert.deepEqual(locate(SLIDE, 'const x = 1;'), { line: 22, endLine: 22 });
  assert.deepEqual(locate(SLIDE, 'A paper, p. 4'), { line: 10, endLine: 10 });
  assert.deepEqual(locate(SLIDE, 'HEADING'), { line: 13, endLine: 13 }, 'case-insensitive, as text-transform changes case');
  assert.equal(locate(SLIDE, 'not in the file'), null);
  assert.equal(locate(SLIDE, '   '), null);
});

test('locate picks the occurrence nearest the hint', () => {
  const raw = 'same words\nother\nsame words\n';
  assert.deepEqual(locate(raw, 'same words', 1), { line: 1, endLine: 1 });
  assert.deepEqual(locate(raw, 'same words', 3), { line: 3, endLine: 3 });
});

test('linesOfRange maps a textarea selection to file lines', () => {
  const t = 'a\nbb\nccc\n';
  assert.deepEqual(linesOfRange(t, 2, 4), { line: 2, endLine: 2 });
  assert.deepEqual(linesOfRange(t, 2, 6), { line: 2, endLine: 3 });
  assert.deepEqual(linesOfRange(t, 0, 5), { line: 1, endLine: 2 }, 'a selection ending after a newline stays on the line before');
});

test('comment files round-trip', () => {
  const text = formatCommentFile({ author: 'octo', created: '2026-11-09T10:00:00Z', file: 'decks/x/slides/02.md', line: 14, endLine: 15, quote: 'some "quoted" text', body: 'Shorter, please.\n' });
  const c = parseCommentFile(text, 'decks/x/comments/1.md');
  assert.equal(c.author, 'octo');
  assert.equal(c.created, '2026-11-09T10:00:00Z');
  assert.equal(c.file, 'decks/x/slides/02.md');
  assert.equal(c.line, 14);
  assert.equal(c.endLine, 15);
  assert.equal(c.quote, 'some "quoted" text');
  assert.equal(c.body, 'Shorter, please.');
  assert.equal(c.kind, 'file');
  assert.throws(() => parseCommentFile('---\nauthor: a\n---\nhi\n', 'c.md'), /needs the file/);
});

test('speakingSeconds estimates the time to read a script aloud', () => {
  assert.equal(speakingSeconds(['one two three', 'four five'], 150), 2);
  assert.equal(speakingSeconds([], 150), 0);
});
