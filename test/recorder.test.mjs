import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webmDuration, pickMime, formatLabel, MIMES } from '../engine/recorder.js';

// A minimal WebM: EBML header, a Segment of unknown size, Info, then a Cluster.
function webm({ duration }) {
  const info = [0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40]; // TimecodeScale = 1,000,000 ns
  if (duration === 'zero64') info.push(0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0);
  if (duration === 'zero32') info.push(0x44, 0x89, 0x84, 0, 0, 0, 0);
  return new Uint8Array([
    0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x86, 0x81, 0x01,
    0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x15, 0x49, 0xA9, 0x66, 0x80 | info.length, ...info,
    0x1F, 0x43, 0xB6, 0x75, 0x90, ...new Array(16).fill(7),
  ]);
}
const bytes = async b => new Uint8Array(await b.arrayBuffer());
const find = (h, seq) => { for (let i = 0; i <= h.length - seq.length; i++) if (seq.every((v, k) => h[i + k] === v)) return i; return -1; };

test('a WebM with no duration (Chrome) gets one inserted into Info', async () => {
  const out = await bytes(await webmDuration(new Blob([webm({})], { type: 'video/webm' }), 2500));
  const at = find(out, [0x15, 0x49, 0xA9, 0x66]);
  assert.equal(out[at + 4], 0x80 | 18, 'Info grows by the 11-byte Duration element');
  const d = find(out, [0x44, 0x89, 0x88]);
  assert.ok(d > at);
  assert.equal(new DataView(out.buffer, out.byteOffset).getFloat64(d + 3), 2500);
  assert.ok(find(out, [0x1F, 0x43, 0xB6, 0x75]) > d, 'the clusters follow, unchanged');
  assert.equal(out.length, webm({}).length + 11);
});

test('a zero duration (Firefox) is overwritten in place', async () => {
  for (const kind of ['zero64', 'zero32']) {
    const src = webm({ duration: kind });
    const out = await bytes(await webmDuration(new Blob([src], { type: 'video/webm' }), 1234));
    assert.equal(out.length, src.length);
    const d = find(out, [0x44, 0x89]);
    const dv = new DataView(out.buffer, out.byteOffset);
    assert.equal(kind === 'zero64' ? dv.getFloat64(d + 3) : dv.getFloat32(d + 3), 1234);
  }
});

test('anything that is not WebM is returned as it was', async () => {
  const mp4 = new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...new Array(40).fill(0)])], { type: 'video/mp4' });
  assert.equal(await webmDuration(mp4, 1000), mp4);
});

test('pickMime prefers MP4 and falls back to WebM', () => {
  assert.equal(pickMime(() => true), MIMES[0]);
  assert.equal(pickMime(m => m.startsWith('video/webm')), 'video/webm;codecs=vp9,opus');
  assert.equal(pickMime(m => m === 'video/mp4'), 'video/mp4');
  assert.equal(pickMime(() => { throw new Error('no'); }), '');
});

test('formatLabel names only the codecs the recorder used', () => {
  assert.equal(formatLabel('video/mp4;codecs=avc3.640028,mp4a.40.2'), 'MP4 (H.264 and AAC)');
  assert.equal(formatLabel('video/mp4;codecs=avc1.42000c,opus'), 'MP4 (H.264 and Opus)');
  assert.equal(formatLabel('video/mp4; codecs="avc1.64001F, mp4a.40.2"'), 'MP4 (H.264 and AAC)');
  assert.equal(formatLabel('video/webm;codecs=vp9,opus'), 'WebM (VP9 and Opus)');
  assert.equal(formatLabel('video/webm;codecs=vp8,opus'), 'WebM (VP8 and Opus)');
  assert.equal(formatLabel('video/webm;codecs=av01,opus'), 'WebM (AV1 and Opus)');
  assert.equal(formatLabel('video/mp4'), 'MP4', 'no codecs listed, none claimed');
  assert.equal(formatLabel(''), 'WebM');
});
