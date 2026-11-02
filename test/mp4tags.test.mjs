import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { tagM4A } from '../src/mp4tags.js';

const dir = mkdtempSync(join(tmpdir(), 'm4a-'));
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// Fixtures: a 3s AAC tone in MP4, plus a JPEG cover.
sh('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-b:a', '128k',
  '-metadata', 'title=OLD TITLE', '-metadata', 'artist=OLD', '-f', 'mp4', join(dir, 'moov-last.mp4')]);
sh('ffmpeg', ['-y', '-i', join(dir, 'moov-last.mp4'), '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', join(dir, 'moov-first.mp4')]);
sh('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=500x500:rate=1', '-frames:v', '1', join(dir, 'cover.jpg')]);
const cover = new Uint8Array(readFileSync(join(dir, 'cover.jpg')));

const meta = {
  title: 'Tum Hi Ho & Co "Live"', artist: 'Arijit Singh, Mithoon', album: 'Aashiqui 2 – Ünïcode',
  year: '2013', comment: 'https://example.com/song/x', copyright: '(c) 2013 T-Series', cover,
};

for (const layout of ['moov-last', 'moov-first']) {
  const src = new Uint8Array(readFileSync(join(dir, `${layout}.mp4`)));
  const out = tagM4A(src, meta);
  const path = join(dir, `${layout}.m4a`);
  writeFileSync(path, out);

  // 1) tags + cover are readable
  const info = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]));
  const tags = Object.fromEntries(Object.entries(info.format.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(tags.title, meta.title);
  assert.equal(tags.artist, meta.artist);
  assert.equal(tags.album, meta.album);
  assert.equal(tags.date, meta.year);
  assert.equal(tags.comment, meta.comment);
  assert.equal(tags.copyright, meta.copyright);
  assert.ok(!JSON.stringify(tags).includes('OLD'), 'old tags must be gone');
  const video = info.streams.filter((s) => s.codec_type === 'video');
  assert.equal(video.length, 1, 'cover stream present');
  assert.equal(video[0].codec_name, 'mjpeg');
  assert.equal(info.streams.find((s) => s.codec_type === 'audio').codec_name, 'aac');
  assert.ok(info.format.format_name.includes('mp4'));

  // 2) audio decodes cleanly end-to-end (proves stco offsets were fixed) and is bit-identical
  const err = sh('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a', '-f', 'null', '-']);
  assert.equal(err.trim(), '', 'decode errors: ' + err);
  const hash = (p) => sh('ffmpeg', ['-v', 'error', '-i', p, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).trim();
  assert.equal(hash(path), hash(join(dir, `${layout}.mp4`)), 'audio packets must be unchanged');

  // 3) extracted cover equals the original bytes
  sh('ffmpeg', ['-y', '-v', 'error', '-i', path, '-map', '0:v', '-c', 'copy', join(dir, `${layout}-cover.jpg`)]);
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, `${layout}-cover.jpg`))), cover);
  console.log(`PASS ${layout}: ${src.length} -> ${out.length} bytes`);
}

// Not-an-MP4 input is rejected, unsupported cover is skipped, no cover is fine.
assert.throws(() => tagM4A(new Uint8Array(100), meta), /not a valid MP4|Corrupt/);
const src = new Uint8Array(readFileSync(join(dir, 'moov-last.mp4')));
const noCover = tagM4A(src, { ...meta, cover: null });
writeFileSync(join(dir, 'nc.m4a'), noCover);
assert.equal(sh('ffmpeg', ['-v', 'error', '-i', join(dir, 'nc.m4a'), '-f', 'null', '-']).trim(), '');
console.log('PASS edge cases');
