/**
 * Cancelling a conversion (CTO re-review 2026-11-03, P2): ffmpeg must never
 * be started after a cancellation, even one that arrives while fluent-ffmpeg
 * is still preparing (before it spawns the process), and a cancelled
 * conversion settles only once ffmpeg has exited.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.SUPABASE_ANON_KEY ||= 'anon';
process.env.LOG_LEVEL ||= 'error';
const { FFmpegService } = await import('../src/services/ffmpeg.js');

let tmp = '';
let input = '';
const options = {
  hlsSegmentDuration: 2, hlsPlaylistType: 'vod' as const, cmafFragmentDuration: 2,
  videoBitrates: [400000], audioBitrate: 64000, outputFormat: 'hls' as const,
  resolutions: [{ width: 640, height: 360, bitrate: 400000 }, { width: 1280, height: 720, bitrate: 1200000 }],
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** ffmpeg processes writing into [dir]. */
const running = (dir: string) => execFileSync('ps', ['-ww', '-eo', 'args']).toString().split('\n')
  .filter(l => l.includes('ffmpeg') && l.includes(dir));
const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-cancel-'));
  input = path.join(tmp, 'long.mp4');
  execFileSync(ffmpegInstaller.path, [
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '60', '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', input,
  ]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a cancellation that arrives before ffmpeg is spawned never lets it start', async () => {
  const out = path.join(tmp, 'early');
  const controller = new AbortController();
  // Cancel exactly while fluent-ffmpeg prepares: run() has been called, and
  // ffmpeg will only be spawned once the asynchronous preparation is done.
  const proto = (ffmpeg as any).prototype;
  const prepare = proto._prepare;
  proto._prepare = function (this: unknown, ...args: unknown[]) {
    proto._prepare = prepare;
    controller.abort(new Error('test cancel'));
    return prepare.apply(this, args);
  };
  try {
    await assert.rejects(new FFmpegService().convertToHls(input, out, options, undefined, controller.signal),
      /conversion cancelled: test cancel/);
  } finally {
    proto._prepare = prepare;
  }
  assert.deepEqual(running(out), [], 'no ffmpeg running once the conversion has settled');
  await sleep(1500);
  assert.deepEqual(running(out), [], 'and none started afterwards');
  assert.deepEqual(files(out).filter(f => f.endsWith('.ts')), [], 'nothing was encoded');
});

test('a cancellation mid-encode settles only after ffmpeg has exited', async () => {
  const out = path.join(tmp, 'mid');
  const controller = new AbortController();
  const conversion = new FFmpegService().convertToHls(input, out, options, undefined, controller.signal);
  for (let i = 0; i < 100 && running(out).length === 0; i++) await sleep(50);
  assert.ok(running(out).length > 0, 'ffmpeg is encoding');
  controller.abort(new Error('test cancel'));
  await assert.rejects(conversion, /conversion cancelled: test cancel/);
  assert.deepEqual(running(out), [], 'ffmpeg had exited when the conversion settled');
  const before = files(out).length;
  await sleep(1000);
  assert.equal(files(out).length, before, 'no file is written after it settled');
});

test('an already cancelled signal starts nothing', async () => {
  const out = path.join(tmp, 'pre');
  const controller = new AbortController();
  controller.abort(new Error('before start'));
  await assert.rejects(new FFmpegService().convertToHls(input, out, options, undefined, controller.signal), /before start/);
  await sleep(500);
  assert.deepEqual(running(out), []);
});
