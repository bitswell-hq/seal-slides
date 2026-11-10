import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serve } from '../scripts/serve.mjs';

test('the dev server serves its folder and nothing beside it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seal-slides-serve-'));
  await mkdir(path.join(dir, 'site', 'deck'), { recursive: true });
  await mkdir(path.join(dir, 'site-old'));
  await writeFile(path.join(dir, 'site', 'index.html'), 'home');
  await writeFile(path.join(dir, 'site', 'deck', 'index.html'), 'deck');
  await writeFile(path.join(dir, 'site-old', 'secret.txt'), 'secret');
  const server = await serve(path.join(dir, 'site'), 0);
  const at = `http://127.0.0.1:${server.address().port}`;
  const get = async p => { const r = await fetch(at + p, { redirect: 'manual' }); return [r.status, await r.text()]; };
  try {
    assert.deepEqual(await get('/'), [200, 'home']);
    assert.deepEqual(await get('/deck/'), [200, 'deck']);
    assert.equal((await get('/deck'))[0], 301);
    assert.equal((await get('/missing.txt'))[0], 404);
    assert.deepEqual(await get('/..%2fsite-old/secret.txt'), [403, '']);
    assert.deepEqual(await get('/..%2f..%2fsite-old%2fsecret.txt'), [403, '']);
    assert.deepEqual(await get('/%E0%A4%A'), [400, '']);
  } finally {
    await new Promise(r => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
