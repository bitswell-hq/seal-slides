import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubClient, DeckStore, GitHubError, ConflictError, patchHunks, rangeInPatch, normalizeReviewComment, commentBody, decodeBase64,
} from '../engine/github.js';
import { parseCommentFile } from '../engine/loader.js';

const API = 'https://api.github.com';
const R = (status, json) => ({ __res: true, status, json });
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// A fake GitHub API: routes are [method, regex, handler(match, body, call)].
// Every call is recorded; an unmatched call fails the test.
function fakeGitHub(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    assert.ok(url.startsWith(API), `request to ${url}`);
    const path = url.slice(API.length);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method, path, body, headers: init.headers };
    calls.push(call);
    for (const [m, re, fn] of routes) {
      const match = m === method && re.exec(path);
      if (!match) continue;
      const out = await fn(match, body, call);
      const { status, json } = out && out.__res ? out : { status: 200, json: out };
      return new Response(json === undefined ? '' : JSON.stringify(json), { status, statusText: String(status) });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { fetch, calls, paths: () => calls.map(c => `${c.method} ${c.path}`) };
}

const REPO = { owner: 'acme', name: 'decks', ref: 'main', sha: 'built-sha', pr: null };
const NOW = () => new Date('2026-11-09T12:34:56.789Z');
const store = (gh, repo = REPO, token = 'github_pat_test') =>
  new DeckStore({ client: new GitHubClient({ token, fetch: gh.fetch }), repo, deckDir: 'decks/example', now: NOW, sleep: async () => {} });

// The git data API calls a commit makes, on a branch whose head is `head`.
const commitRoutes = (owner, name, branch, head, onCommit = () => {}) => [
  ['GET', new RegExp(`^/repos/${owner}/${name}/git/ref/heads/${branch.replace(/\//g, '/')}$`), () => ({ object: { sha: head } })],
  ['GET', new RegExp(`^/repos/${owner}/${name}/git/commits/${head}$`), () => ({ sha: head, tree: { sha: 'tree-' + head } })],
  ['POST', new RegExp(`^/repos/${owner}/${name}/git/trees$`), () => R(201, { sha: 'new-tree' })],
  ['POST', new RegExp(`^/repos/${owner}/${name}/git/commits$`), (_, body) => { onCommit(body); return R(201, { sha: 'new-commit', html_url: `https://github.com/${owner}/${name}/commit/new-commit` }); }],
  ['PATCH', new RegExp(`^/repos/${owner}/${name}/git/refs/heads/${branch}$`), () => ({ object: { sha: 'new-commit' } })],
];

test('the client sends the token as a bearer header and JSON bodies', async () => {
  const gh = fakeGitHub([['POST', /^\/x$/, (_, body) => R(201, { got: body })]]);
  const c = new GitHubClient({ token: 'github_pat_abc', fetch: gh.fetch });
  assert.deepEqual(await c.post('/x', { a: 1 }), { got: { a: 1 } });
  assert.equal(gh.calls[0].headers.Authorization, 'Bearer github_pat_abc');
  assert.equal(gh.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(gh.calls[0].headers.Accept, 'application/vnd.github+json');
});

test('without a token no Authorization header is sent', async () => {
  const gh = fakeGitHub([['GET', /^\/x$/, () => ({})]]);
  await new GitHubClient({ fetch: gh.fetch }).get('/x');
  assert.equal(gh.calls[0].headers.Authorization, undefined);
});

test('API errors carry the status and GitHub\'s message', async () => {
  const gh = fakeGitHub([['GET', /^\/x$/, () => R(422, { message: 'Validation Failed', errors: [{ message: 'line must be part of the diff' }] })]]);
  await assert.rejects(new GitHubClient({ fetch: gh.fetch }).get('/x'), e => e instanceof GitHubError && e.status === 422 && /Validation Failed \(line must be part of the diff\)/.test(e.message));
});

test('base64 from the contents API decodes as UTF-8', () => {
  assert.equal(decodeBase64(b64('naïve — ✓\n').replace(/(.{8})/g, '$1\n')), 'naïve — ✓\n');
});

test('patchHunks reads new-file line numbers per hunk', () => {
  const patch = '@@ -1,3 +1,4 @@\n a\n-b\n+B\n+C\n c\n@@ -20,2 +21,2 @@\n x\n-y\n+Y\n\\ No newline at end of file';
  const hunks = patchHunks(patch);
  assert.deepEqual([...hunks[0]], [1, 2, 3, 4]);
  assert.deepEqual([...hunks[1]], [21, 22]);
  assert.ok(rangeInPatch(patch, 2, 3));
  assert.ok(!rangeInPatch(patch, 4, 21), 'a range across two hunks cannot anchor a comment');
  assert.ok(!rangeInPatch(patch, 10));
  assert.ok(!rangeInPatch(undefined, 1));
  assert.ok(!rangeInPatch(patch, null));
});

test('saveEdit on a new branch: branch from the built commit, one commit, a pull request', async () => {
  let commitBody;
  const branch = 'seal-slides/example/octo-20261109-123456Z';
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: true } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => []],
    ['POST', /^\/repos\/acme\/decks\/git\/refs$/, (_, body) => { assert.deepEqual(body, { ref: `refs/heads/${branch}`, sha: 'built-sha' }); return R(201, {}); }],
    ...commitRoutes('acme', 'decks', branch, 'built-sha', b => { commitBody = b; }),
    ['POST', /^\/repos\/acme\/decks\/pulls$/, (_, body) => {
      assert.equal(body.head, branch);
      assert.equal(body.base, 'main');
      assert.equal(body.title, 'Edit 02-folder.md');
      return R(201, { number: 7, html_url: 'https://github.com/acme/decks/pull/7' });
    }],
  ]);
  const r = await store(gh).saveEdit({ files: [{ path: 'decks/example/slides/02-folder.md', content: 'new text', base: 'old text' }], message: 'Edit 02-folder.md' });
  assert.equal(r.branch, branch);
  assert.equal(r.pr.number, 7);
  assert.ok(r.createdPr);
  assert.equal(r.commit.sha, 'new-commit');
  assert.deepEqual(commitBody, { message: 'Edit 02-folder.md', tree: 'new-tree', parents: ['built-sha'] });
  const tree = gh.calls.find(c => c.path.endsWith('/git/trees')).body;
  assert.deepEqual(tree, { base_tree: 'tree-built-sha', tree: [{ path: 'decks/example/slides/02-folder.md', mode: '100644', type: 'blob', content: 'new text' }] });
  assert.ok(!gh.paths().some(p => p.includes('/contents/')), 'a fresh branch needs no conflict check');
});

test('saveEdit reuses the viewer\'s open pull request and checks for conflicts', async () => {
  const branch = 'seal-slides/example/octo-20261101-090000Z';
  const pull = { number: 3, html_url: 'https://github.com/acme/decks/pull/3', user: { login: 'octo' }, head: { ref: branch, repo: { full_name: 'acme/decks' } }, base: { ref: 'main' } };
  const other = { number: 4, user: { login: 'someone' }, head: { ref: 'seal-slides/example/someone-1', repo: { full_name: 'acme/decks' } }, base: { ref: 'main' } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: true } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [other, pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/3\/files/, () => [{ filename: 'decks/example/slides/02.md', status: 'modified' }]],
    ['GET', /^\/repos\/acme\/decks\/contents\/decks\/example\/slides\/02\.md\?ref=/, m => ({ content: b64('old text') })],
    ...commitRoutes('acme', 'decks', branch, 'branch-head'),
  ]);
  const r = await store(gh).saveEdit({ files: [{ path: 'decks/example/slides/02.md', content: 'new text', base: 'old text' }], message: 'Edit' });
  assert.equal(r.pr.number, 3);
  assert.equal(r.createdPr, false);
  assert.ok(!gh.paths().some(p => p === 'POST /repos/acme/decks/pulls'), 'no second pull request');
  assert.ok(gh.paths().includes(`GET /repos/acme/decks/contents/decks/example/slides/02.md?ref=${encodeURIComponent(branch)}`));
});

test('saveEdit refuses to overwrite a file that changed on the branch', async () => {
  const branch = 'seal-slides/example/octo-1';
  const pull = { number: 3, html_url: 'u', user: { login: 'octo' }, head: { ref: branch, repo: { full_name: 'acme/decks' } }, base: { ref: 'main' } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: true } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/3\/files/, () => [{ filename: 'decks/example/slides/02.md', status: 'modified' }]],
    ['GET', /\/contents\//, () => ({ content: b64('someone else changed this') })],
  ]);
  await assert.rejects(store(gh).saveEdit({ files: [{ path: 'decks/example/slides/02.md', content: 'mine', base: 'old' }], message: 'Edit' }), ConflictError);
  assert.ok(!gh.paths().some(p => p.includes('/git/')), 'nothing was committed');
});

test('a conflict names the pull request that holds the newer version', async () => {
  const pull = { number: 3, html_url: 'https://github.com/acme/decks/pull/3', user: { login: 'octo' }, head: { ref: 'seal-slides/example/octo-1', repo: { full_name: 'acme/decks' } }, base: { ref: 'main' } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: true } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/3\/files/, () => [{ filename: 'decks/example/slides/02.md', status: 'modified' }]],
    ['GET', /\/contents\//, () => ({ content: b64('changed since') })],
  ]);
  await assert.rejects(store(gh).saveEdit({ files: [{ path: 'decks/example/slides/02.md', content: 'mine', base: 'old' }], message: 'Edit' }), e =>
    e instanceof ConflictError && e.path === 'decks/example/slides/02.md' && e.pr.number === 3 && e.pr.url === pull.html_url &&
    e.message.includes('pull request #3') && e.message.includes(pull.html_url) && !/reload/.test(e.message));
});

test('a second edit builds on the viewer\'s open pull request, not on the page as built', async () => {
  const branch = 'seal-slides/example/octo-20261101-090000Z';
  const path = 'decks/example/slides/01-title.md';
  const pull = { number: 3, html_url: 'https://github.com/acme/decks/pull/3', user: { login: 'octo' }, head: { ref: branch, repo: { full_name: 'acme/decks' } }, base: { ref: 'main' } };
  const onBranch = { [path]: 'T1', 'decks/example/animations/dial.js': 'draw 1' };
  let tree;
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: true } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/3\/files/, () => [
      { filename: path, status: 'modified' },
      { filename: 'decks/example/animations/dial.js', status: 'modified' },
      { filename: 'decks/example/slides/09-gone.md', status: 'removed' },
      { filename: 'decks/example/comments/20261101-090000Z-octo.md', status: 'added' },
      { filename: 'decks/other/slides/01.md', status: 'modified' },
      { filename: 'README.md', status: 'modified' },
    ]],
    ['GET', /^\/repos\/acme\/decks\/contents\/(.+)\?ref=(.+)$/, m => {
      assert.equal(decodeURIComponent(m[2]), branch);
      return m[1] in onBranch ? { content: b64(onBranch[m[1]]) } : R(404, { message: 'Not Found' });
    }],
    ['POST', /^\/repos\/acme\/decks\/git\/trees$/, (_, body) => { tree = body; return R(201, { sha: 'new-tree' }); }],
    ...commitRoutes('acme', 'decks', branch, 'branch-head'),
  ]);
  const s = store(gh);
  const p = await s.pending();
  assert.deepEqual(p.pr, { number: 3, url: 'https://github.com/acme/decks/pull/3' });
  assert.equal(p.branch, branch);
  assert.deepEqual([...p.files], [[path, 'T1'], ['decks/example/animations/dial.js', 'draw 1']]);
  assert.ok(!gh.paths().some(x => !x.startsWith('GET ')), 'looking writes nothing');

  // The page was built with T0. Saving from T0 is refused; saving from what pending() loaded goes through.
  await assert.rejects(s.saveEdit({ files: [{ path, content: 'T0 edited', base: 'T0' }], message: 'Edit' }), ConflictError);
  const r = await s.saveEdit({ files: [{ path, content: 'T2', base: p.files.get(path) }], message: 'Edit again' });
  assert.equal(r.pr.number, 3);
  assert.equal(r.createdPr, false);
  assert.deepEqual(tree.tree, [{ path, mode: '100644', type: 'blob', content: 'T2' }]);
});

test('a file the pull request does not change is saved although the branch holds an older text of it', async () => {
  const branch = 'seal-slides/example/octo-1';
  const path = 'decks/example/slides/02.md';
  const pull = { number: 3, html_url: 'https://github.com/acme/decks/pull/3', user: { login: 'octo' }, head: { ref: branch, repo: { full_name: 'acme/decks' } }, base: { ref: 'main' } };
  let tree;
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: true } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/3\/files/, () => [{ filename: 'decks/example/comments/20261101-090000Z-octo.md', status: 'added' }]],
    ['GET', /\/contents\//, () => ({ content: b64('as the branch was cut') })],
    ['POST', /^\/repos\/acme\/decks\/git\/trees$/, (_, body) => { tree = body; return R(201, { sha: 'new-tree' }); }],
    ...commitRoutes('acme', 'decks', branch, 'branch-head'),
  ]);
  const r = await store(gh).saveEdit({ files: [{ path, content: 'edited from main', base: 'merged into main since' }], message: 'Edit' });
  assert.equal(r.pr.number, 3);
  assert.equal(r.createdPr, false);
  assert.deepEqual(tree.tree, [{ path, mode: '100644', type: 'blob', content: 'edited from main' }]);
});

test('pending is null without an open pull request of the viewer\'s, and does not fork', async () => {
  const others = { number: 4, html_url: 'u', user: { login: 'someone' }, head: { ref: 'seal-slides/example/someone-1', repo: { full_name: 'acme/decks' } }, base: { ref: 'main' } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: false } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [others]],
  ]);
  assert.equal(await store(gh).pending(), null);
  assert.deepEqual(gh.paths(), ['GET /user', 'GET /repos/acme/decks', 'GET /repos/acme/decks/pulls?state=open&per_page=100']);
});

test('without push access, pending and saveEdit use the pull request\'s fork branch', async () => {
  const branch = 'seal-slides/example/octo-1';
  const path = 'decks/example/slides/02.md';
  const pull = { number: 9, html_url: 'https://github.com/acme/decks/pull/9', user: { login: 'octo' }, head: { ref: branch, repo: { full_name: 'octo/decks', name: 'decks', owner: { login: 'octo' } } }, base: { ref: 'main' } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: false } })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/9\/files/, () => [{ filename: path, status: 'modified' }]],
    ['GET', /^\/repos\/octo\/decks\/contents\//, () => ({ content: b64('T1') })],
    ...commitRoutes('octo', 'decks', branch, 'fork-head'),
  ]);
  const s = store(gh);
  const p = await s.pending();
  assert.equal(p.files.get(path), 'T1');
  const r = await s.saveEdit({ files: [{ path, content: 'T2', base: 'T1' }], message: 'Edit' });
  assert.equal(r.repo, 'octo/decks');
  assert.equal(r.pr.number, 9);
  assert.ok(!gh.paths().some(x => x.includes('/forks')), 'the fork already holds the branch');
});

test('without push access, saveEdit forks, branches in the fork and opens a cross-repository pull request', async () => {
  const branch = 'seal-slides/example/octo-20261109-123456Z';
  let forked = false;
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: false } })],
    ['GET', /^\/repos\/octo\/decks$/, () => R(404, { message: 'Not Found' })],
    ['POST', /^\/repos\/acme\/decks\/forks$/, () => { forked = true; return R(202, { owner: { login: 'octo' }, name: 'decks' }); }],
    ['GET', /^\/repos\/octo\/decks\/commits\?per_page=1$/, () => (forked ? [{}] : R(404, {}))],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => []],
    ['POST', /^\/repos\/octo\/decks\/git\/refs$/, () => R(201, {})],
    ...commitRoutes('octo', 'decks', branch, 'built-sha'),
    ['POST', /^\/repos\/acme\/decks\/pulls$/, (_, body) => {
      assert.equal(body.head, `octo:${branch}`);
      assert.equal(body.base, 'main');
      assert.equal(body.maintainer_can_modify, true);
      return R(201, { number: 9, html_url: 'https://github.com/acme/decks/pull/9' });
    }],
  ]);
  const r = await store(gh).saveEdit({ files: [{ path: 'decks/example/slides/02.md', content: 'new', base: 'old' }], message: 'Edit' });
  assert.equal(r.repo, 'octo/decks');
  assert.equal(r.pr.number, 9);
});

test('a fork that lags behind is synced once before branching', async () => {
  let refTries = 0;
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: {} })],
    ['GET', /^\/repos\/octo\/decks$/, () => ({ fork: true, parent: { full_name: 'acme/decks' }, owner: { login: 'octo' }, name: 'decks' })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => []],
    ['POST', /^\/repos\/octo\/decks\/git\/refs$/, () => (++refTries === 1 ? R(422, { message: 'Object does not exist' }) : R(201, {}))],
    ['POST', /^\/repos\/octo\/decks\/merge-upstream$/, (_, body) => { assert.deepEqual(body, { branch: 'main' }); return {}; }],
    ...commitRoutes('octo', 'decks', 'seal-slides/example/octo-20261109-123456Z', 'built-sha'),
    ['POST', /^\/repos\/acme\/decks\/pulls$/, () => R(201, { number: 10, html_url: 'u' })],
  ]);
  await store(gh).saveEdit({ files: [{ path: 'decks/example/slides/02.md', content: 'new' }], message: 'Edit' });
  assert.equal(refTries, 2);
});

const PATCH = '@@ -10,4 +10,5 @@\n context\n-old\n+new line 11\n+new line 12\n context\n context';

test('saveComment posts a line comment when the lines are in an open pull request\'s diff', async () => {
  const pull = { number: 5, html_url: 'https://github.com/acme/decks/pull/5', user: { login: 'someone' }, head: { ref: 'x', sha: 'built-sha', repo: { name: 'decks', owner: { login: 'acme' } } } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/5\/files/, () => [{ filename: 'decks/example/slides/02.md', status: 'modified', patch: PATCH }]],
    ['POST', /^\/repos\/acme\/decks\/pulls\/5\/comments$/, (_, body) => R(201, { id: 1, body: body.body, path: body.path, line: body.line, start_line: body.start_line, user: { login: 'octo' }, html_url: 'https://github.com/acme/decks/pull/5#discussion_r1', pull_request_url: 'https://api.github.com/repos/acme/decks/pulls/5', created_at: '2026-11-09T12:00:00Z' })],
  ]);
  const r = await store(gh).saveComment({ anchor: { file: 'decks/example/slides/02.md', line: 11, endLine: 12, quote: 'new line' }, body: 'Tighten this.' });
  assert.equal(r.kind, 'review-line');
  const post = gh.calls.at(-1).body;
  assert.deepEqual(post, { body: 'Tighten this.', commit_id: 'built-sha', path: 'decks/example/slides/02.md', line: 12, side: 'RIGHT', start_line: 11, start_side: 'RIGHT' });
  assert.equal(r.comment.pr, 5);
  assert.equal(r.comment.line, 11);
  assert.equal(r.comment.endLine, 12);
});

test('saveComment posts a file comment, quoting the text, when the lines are outside the diff', async () => {
  const pull = { number: 5, html_url: 'u5', user: { login: 'octo' }, head: { ref: 'seal-slides/example/octo-1', sha: 'built-sha', repo: { name: 'decks', owner: { login: 'acme' } } } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/5\/files/, () => [{ filename: 'decks/example/slides/02.md', status: 'modified', patch: PATCH }]],
    ['POST', /^\/repos\/acme\/decks\/pulls\/5\/comments$/, (_, body) => R(201, { id: 2, ...body, user: { login: 'octo' }, pull_request_url: '/pulls/5' })],
  ]);
  const r = await store(gh).saveComment({ anchor: { file: 'decks/example/slides/02.md', line: 3, endLine: 3, quote: 'a title' }, body: 'Rename?' });
  assert.equal(r.kind, 'review-file');
  const post = gh.calls.at(-1).body;
  assert.equal(post.subject_type, 'file');
  assert.equal(post.line, undefined);
  assert.equal(post.body, '> a title\n\nLine 3:\n\nRename?');
});

test('saveComment finds the quote again when the pull request has another version of the file', async () => {
  const pull = { number: 6, html_url: 'u6', user: { login: 'someone' }, head: { ref: 'x', sha: 'pr-head', repo: { name: 'decks', owner: { login: 'acme' } } } };
  const prText = 'line 1\nline 2\ninserted\ninserted\nthe quoted words\n';
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [pull]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/6\/files/, () => [{ filename: 'decks/example/slides/02.md', status: 'modified', patch: '@@ -1,3 +1,5 @@\n line 1\n line 2\n+inserted\n+inserted\n the quoted words' }]],
    ['GET', /^\/repos\/acme\/decks\/contents\/decks\/example\/slides\/02\.md\?ref=pr-head$/, () => ({ content: b64(prText) })],
    ['POST', /^\/repos\/acme\/decks\/pulls\/6\/comments$/, (_, body) => R(201, { id: 3, ...body, user: { login: 'octo' }, pull_request_url: '/pulls/6' })],
  ]);
  const r = await store(gh).saveComment({ anchor: { file: 'decks/example/slides/02.md', line: 3, endLine: 3, quote: 'the quoted words' }, body: 'Hm.' });
  assert.equal(r.kind, 'review-line');
  assert.equal(gh.calls.at(-1).body.line, 5, 'line 3 as built is line 5 in the pull request');
  assert.equal(gh.calls.at(-1).body.commit_id, 'pr-head');
});

test('saveComment finds the viewer\'s own pull request among many open ones', async () => {
  const file = 'decks/example/slides/02.md';
  const others = Array.from({ length: 11 }, (_, i) => ({ number: 20 + i, html_url: 'u', user: { login: 'someone' }, head: { ref: `feature-${i}`, sha: 'built-sha', repo: { name: 'decks', owner: { login: 'acme' } } } }));
  const own = { number: 5, html_url: 'https://github.com/acme/decks/pull/5', user: { login: 'octo' }, head: { ref: 'seal-slides/example/octo-1', sha: 'built-sha', repo: { name: 'decks', owner: { login: 'acme' } } } };
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [...others, own]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/5\/files/, () => [{ filename: file, status: 'modified', patch: PATCH }]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/\d+\/files/, () => [{ filename: 'README.md', status: 'modified', patch: '' }]],
    ['POST', /^\/repos\/acme\/decks\/pulls\/5\/comments$/, (_, body) => R(201, { id: 4, ...body, user: { login: 'octo' }, pull_request_url: '/pulls/5' })],
  ]);
  const r = await store(gh).saveComment({ anchor: { file, line: 11, endLine: 11, quote: 'new line 11' }, body: 'On my own pull request.' });
  assert.equal(r.kind, 'review-line');
  assert.equal(r.pr.number, 5);
  assert.ok(gh.paths().filter(p => /\/pulls\/\d+\/files/.test(p)).length <= 10, 'at most ten pull requests have their files read');
});

test('saveComment commits a comment file, with a pull request, when no open pull request changes the file', async () => {
  const branch = 'seal-slides/example/octo-20261109-123456Z';
  const gh = fakeGitHub([
    ['GET', /^\/user$/, () => ({ login: 'octo' })],
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [{ number: 8, user: { login: 'x' }, head: { ref: 'other', repo: {} } }]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/8\/files/, () => [{ filename: 'README.md', status: 'modified', patch: '' }]],
    ['GET', /^\/repos\/acme\/decks$/, () => ({ default_branch: 'main', permissions: { push: true } })],
    ['POST', /^\/repos\/acme\/decks\/git\/refs$/, () => R(201, {})],
    ...commitRoutes('acme', 'decks', branch, 'built-sha'),
    ['POST', /^\/repos\/acme\/decks\/pulls$/, (_, body) => { assert.equal(body.title, 'Comment on decks/example/slides/02.md:4'); return R(201, { number: 11, html_url: 'https://github.com/acme/decks/pull/11' }); }],
  ]);
  const r = await store(gh).saveComment({ anchor: { file: 'decks/example/slides/02.md', line: 4, endLine: 5, quote: 'two lines' }, body: 'Split this slide.' });
  assert.equal(r.kind, 'file');
  assert.equal(r.path, 'decks/example/comments/20261109-123456Z-octo.md');
  assert.equal(r.pr.number, 11);
  const tree = gh.calls.find(c => c.path.endsWith('/git/trees')).body.tree[0];
  assert.equal(tree.path, r.path);
  const c = parseCommentFile(tree.content, tree.path);
  assert.equal(c.author, 'octo');
  assert.equal(c.file, 'decks/example/slides/02.md');
  assert.equal(c.line, 4);
  assert.equal(c.endLine, 5);
  assert.equal(c.quote, 'two lines');
  assert.equal(c.body, 'Split this slide.');
  assert.equal(c.created, '2026-11-09T12:34:56Z');
});

test('an empty comment is refused before any request', async () => {
  const gh = fakeGitHub([]);
  await assert.rejects(store(gh).saveComment({ anchor: { file: 'f', line: 1 }, body: '  ' }), /empty/);
  assert.equal(gh.calls.length, 0);
});

test('listComments keeps review comments of open pull requests on this deck\'s files', async () => {
  const gh = fakeGitHub([
    ['GET', /^\/repos\/acme\/decks\/pulls\?state=open/, () => [{ number: 5 }]],
    ['GET', /^\/repos\/acme\/decks\/pulls\/comments\?/, () => [
      { id: 1, path: 'decks/example/slides/02.md', line: 12, start_line: 11, body: 'a', user: { login: 'u' }, pull_request_url: 'https://api.github.com/repos/acme/decks/pulls/5', html_url: 'h1', created_at: 't' },
      { id: 2, path: 'decks/other/slides/01.md', line: 1, body: 'other deck', pull_request_url: '.../pulls/5' },
      { id: 3, path: 'decks/example/slides/03.md', line: 1, body: 'closed pr', pull_request_url: '.../pulls/4' },
      { id: 4, path: 'decks/example/animations/x.js', line: null, original_line: 7, body: 'outdated', user: { login: 'v' }, pull_request_url: '.../pulls/5' },
    ]],
  ]);
  const list = await store(gh, REPO, null).listComments();
  assert.deepEqual(list.map(c => c.id), ['review:1', 'review:4']);
  assert.deepEqual([list[0].line, list[0].endLine, list[0].pr, list[0].author], [11, 12, 5, 'u']);
  assert.equal(list[1].outdated, true);
  assert.equal(list[1].line, 7);
  assert.equal(gh.calls[0].headers.Authorization, undefined, 'read-only viewers need no token');
});

test('a preview lists its own pull request\'s comments', async () => {
  const gh = fakeGitHub([
    ['GET', /^\/repos\/acme\/decks\/pulls\/12\/comments/, () => [{ id: 1, path: 'decks/example/slides/01.md', line: 2, body: 'x', pull_request_url: '/pulls/12', subject_type: 'line' }]],
  ]);
  const list = await store(gh, { ...REPO, pr: 12 }, null).listComments();
  assert.equal(list.length, 1);
  assert.equal(list[0].pr, 12);
});

test('commentBody quotes the anchor for file-level comments only', () => {
  assert.equal(commentBody({ quote: 'q', line: 2, endLine: 4 }, ' body ', true), 'body');
  assert.equal(commentBody({ quote: 'one\ntwo', line: 2, endLine: 4 }, 'body', false), '> one\n> two\n\nLine 2–4:\n\nbody');
  assert.equal(commentBody({ quote: '', line: null }, 'body', false), 'Whole slide:\n\nbody');
});

test('normalizeReviewComment marks file-level comments as current', () => {
  const c = normalizeReviewComment({ id: 9, path: 'p', line: null, subject_type: 'file', body: 'b', pull_request_url: '/pulls/3' });
  assert.equal(c.outdated, false);
  assert.equal(c.line, null);
});
