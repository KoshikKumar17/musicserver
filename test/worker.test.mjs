// End-to-end tests: Worker + fake D1 (node:sqlite) + mocked network, including every error path.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

console.warn = () => {}; // keep test output readable
const realError = console.error;
console.error = () => {};

const dir = mkdtempSync(join(tmpdir(), 'w-'));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:a', 'aac', '-f', 'mp4', join(dir, 's.mp4')]);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=500x500', '-frames:v', '1', join(dir, 'c.jpg')]);
const SONG = readFileSync(join(dir, 's.mp4'));
const COVER = readFileSync(join(dir, 'c.jpg'));
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA);
  const DB = {
    prepare(sql) {
      return {
        bind(...a) {
          return {
            first: async () => sqlite.prepare(sql).get(...a) ?? null,
            run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...a).changes) } }),
          };
        },
      };
    },
  };
  return { sqlite, DB };
}
let { sqlite, DB } = makeDb();

// --- mocked network (each hook may return a Response, throw, or return undefined to use the default) ---
const calls = {};
const hooks = {};
const bump = (k) => (calls[k] = (calls[k] ?? 0) + 1);
const tgStore = new Map();
let nextId = 1;
const META = {
  data: [{ id: 'abc123', name: 'Tum Hi Ho &amp; Co', year: '2013', duration: 262, url: 'https://x/y', copyright: '&#169; 2013',
    album: { name: 'Aashiqui 2' }, artists: { primary: [{ name: 'Arijit Singh' }, { name: 'Mithoon' }] },
    image: [{ quality: '500x500', url: 'https://img/500.jpg' }],
    downloadUrl: [{ quality: '160kbps', url: 'https://cdn/160.mp4' }, { quality: '320kbps', url: 'https://cdn/320.mp4' }] }],
};
const tgErr = (status, description, extra = {}) => Response.json({ ok: false, description, ...extra }, { status });

globalThis.fetch = async (input, init) => {
  const url = String(input);
  const kind = url.includes('/api/songs') ? 'saavn' : url === 'https://cdn/320.mp4' ? 'audio' : url.includes('img/') || url.includes('ibb.co') ? 'cover'
    : url.endsWith('/sendDocument') ? 'upload' : url.includes('/getFile') ? 'getFile' : url.includes('/file/bot') ? 'tgDownload' : 'other';
  bump(kind);
  if (hooks[kind]) { const r = await hooks[kind](url, init); if (r) return r; }
  switch (kind) {
    case 'saavn': return Response.json(META);
    case 'audio': return new Response(SONG);
    case 'cover': return new Response(COVER);
    case 'upload': {
      const doc = init.body.get('document');
      assert.ok(doc.name.endsWith('.m4a'), 'uploaded as .m4a: ' + doc.name);
      assert.match(init.body.get('caption'), /id: abc123/);
      const fid = 'FILEID' + nextId++;
      tgStore.set(fid, new Uint8Array(await doc.arrayBuffer()));
      return Response.json({ ok: true, result: { message_id: 7, document: { file_id: fid } } });
    }
    case 'getFile': {
      const fid = new URL(url).searchParams.get('file_id');
      return tgStore.has(fid) ? Response.json({ ok: true, result: { file_path: 'docs/' + fid } }) : tgErr(400, 'Bad Request: wrong file_id');
    }
    case 'tgDownload': { const b = tgStore.get(url.split('/docs/')[1]); return new Response(b, { headers: { 'Content-Length': String(b.length) } }); }
  }
  throw new Error('unexpected fetch ' + url);
};

let env = { DB, TELEGRAM_TOKEN: '123:SECRET', GROUP_ID: '-100123' };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const get = (path, e = env) => worker.fetch(new Request('https://w.dev' + path), e, ctx);
const reset = () => {
  for (const k of Object.keys(calls)) delete calls[k];
  for (const k of Object.keys(hooks)) delete hooks[k];
  sqlite.exec('DELETE FROM tracks; DELETE FROM jobs');
};
async function fails(path, status, code, { retryable, e } = {}) {
  const r = await get(path, e);
  const body = await r.json();
  assert.equal(r.status, status, `${path}: expected ${status} got ${r.status} ${JSON.stringify(body)}`);
  assert.equal(body.code, code, JSON.stringify(body));
  assert.equal(body.status, 'Failed');
  if (retryable !== undefined) assert.equal(body.retryable, retryable, code);
  assert.ok(!JSON.stringify(body).includes('SECRET'), 'token leaked');
  return { r, body };
}
const timeout = () => { throw new DOMException('timed out', 'TimeoutError'); };

// ================= happy paths =================
let r = await get('/download?id=abc123');
assert.equal(r.status, 200);
assert.equal(r.headers.get('Content-Type'), 'audio/mp4');
assert.match(r.headers.get('Content-Disposition'), /Tum Hi Ho & Co - Arijit Singh, Mithoon\.m4a/);
const first = new Uint8Array(await r.arrayBuffer());
assert.deepEqual([calls.saavn, calls.audio, calls.upload], [1, 1, 1]);

r = await get('/download?id=abc123'); // cached in Telegram: no metadata/audio/upload calls
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), first);
assert.deepEqual([calls.saavn, calls.audio, calls.upload, calls.tgDownload], [1, 1, 1, 1]);
assert.deepEqual(await (await get('/status?id=abc123')).json(), { status: 'Done', url: '/download?id=abc123', size: (first.length / 1048576).toFixed(2) });
assert.deepEqual(await (await get('/status?id=nope')).json(), { status: 'Not in queue' });
assert.deepEqual(await (await get('/add?id=abc123')).json(), { status: 'success', cached: true });
assert.equal((await get('/')).status, 200);

// file vanished from Telegram -> stale row dropped, rebuilt
tgStore.clear();
r = await get('/download?id=abc123');
assert.equal(r.status, 200);
assert.equal(calls.upload, 2);

// concurrent requests build once
reset();
const rs = await Promise.all([get('/download?id=abc123'), get('/download?id=abc123'), get('/download?id=abc123')]);
rs.forEach((x) => assert.equal(x.status, 200));
assert.equal(calls.upload, 1);

// /add in background
reset();
assert.deepEqual(await (await get('/add?id=abc123')).json(), { status: 'success' });
assert.equal((await (await get('/status?id=abc123')).json()).status, 'Compiling');
await Promise.all(pending);
assert.equal((await (await get('/status?id=abc123')).json()).status, 'Done');

// cover failure is not fatal
reset();
hooks.cover = () => new Response('nope', { status: 404 });
assert.equal((await get('/download?id=abc123')).status, 200);
console.log('PASS happy paths');

// ================= request / config errors =================
reset();
await fails('/download', 400, 'MISSING_ID', { retryable: false });
await fails('/download?id=../../etc', 400, 'INVALID_ID');
await fails('/download?id=' + 'a'.repeat(41), 400, 'INVALID_ID');
assert.equal((await get('/nothing')).status, 404);
r = await worker.fetch(new Request('https://w.dev/add?id=x', { method: 'POST' }), env, ctx);
assert.equal(r.status, 405);
assert.equal((await worker.fetch(new Request('https://w.dev/add', { method: 'OPTIONS' }), env, ctx)).status, 204);
await fails('/download?id=abc123', 500, 'CONFIG_ERROR', { e: { ...env, TELEGRAM_TOKEN: undefined } });
await fails('/download?id=abc123', 500, 'CONFIG_ERROR', { e: { ...env, GROUP_ID: '' } });
await fails('/download?id=abc123', 500, 'CONFIG_ERROR', { e: { ...env, DB: undefined } });
function makeDbNoSchema() {
  const s = new DatabaseSync(':memory:');
  return { prepare: (sql) => ({ bind: (...a) => ({ first: async () => s.prepare(sql).get(...a), run: async () => ({ meta: { changes: Number(s.prepare(sql).run(...a).changes) } }) }) }) };
}
await fails('/download?id=abc123', 500, 'DB_NOT_INITIALIZED', { e: { ...env, DB: makeDbNoSchema() } });
console.log('PASS request/config errors');

// ================= metadata API =================
reset();
hooks.saavn = () => Response.json({ success: false, message: 'not found' }, { status: 404 });
await fails('/download?id=zzz', 404, 'TRACK_NOT_FOUND', { retryable: false });
await fails('/download?id=zzz', 404, 'TRACK_NOT_FOUND'); // answered from cooldown cache
assert.equal(calls.saavn, 1, 'permanent failure must not hammer the API');
assert.deepEqual(await (await get('/status?id=zzz')).json(), { status: 'Failed', code: 'TRACK_NOT_FOUND', message: 'Track "zzz" was not found', retryable: false });
await fails('/add?id=zzz', 404, 'TRACK_NOT_FOUND');

reset(); hooks.saavn = () => Response.json({ success: true, data: [] });
await fails('/download?id=zzz', 404, 'TRACK_NOT_FOUND');

reset(); hooks.saavn = () => new Response('error code: 1042\n', { status: 404 });
await fails('/download?id=zzz', 502, 'METADATA_API_BLOCKED', { retryable: false });

reset(); hooks.saavn = () => new Response('<html>gone</html>', { status: 404 });
await fails('/download?id=zzz', 502, 'METADATA_API_ERROR', { retryable: false });

reset(); hooks.saavn = () => new Response('oops', { status: 500 });
await fails('/download?id=zzz', 502, 'METADATA_API_ERROR', { retryable: true });
await fails('/download?id=zzz', 502, 'METADATA_API_ERROR'); // retryable -> retried, not cached
assert.equal(calls.saavn, 2);

reset(); hooks.saavn = () => new Response('slow down', { status: 429 });
r = (await fails('/download?id=zzz', 503, 'METADATA_API_RATE_LIMITED', { retryable: true })).r;
assert.equal(r.headers.get('Retry-After'), '30');

reset(); hooks.saavn = () => new Response('<html>', { status: 200 });
await fails('/download?id=zzz', 502, 'METADATA_API_INVALID', { retryable: true });

reset(); hooks.saavn = () => Response.json({ success: true, data: [{ ...META.data[0], downloadUrl: [] }] });
await fails('/download?id=zzz', 422, 'NO_DOWNLOAD_URL', { retryable: false });

reset(); hooks.saavn = () => { throw new TypeError('fetch failed'); };
await fails('/download?id=zzz', 502, 'UPSTREAM_UNREACHABLE', { retryable: true });
reset(); hooks.saavn = timeout;
await fails('/download?id=zzz', 504, 'UPSTREAM_TIMEOUT', { retryable: true });

reset();
await fails('/download?id=abc123', 500, 'CONFIG_ERROR', { e: { ...env, SAAVN_API: 'not a url' } });
console.log('PASS metadata errors');

// ================= audio download / tagging =================
reset(); hooks.audio = () => new Response('denied', { status: 403 });
await fails('/download?id=abc123', 502, 'AUDIO_UNAVAILABLE', { retryable: true });
reset(); hooks.audio = () => new Response('x', { status: 503 });
await fails('/download?id=abc123', 502, 'AUDIO_SERVER_ERROR', { retryable: true });
reset(); hooks.audio = () => new Response('x', { status: 429 });
await fails('/download?id=abc123', 503, 'AUDIO_RATE_LIMITED', { retryable: true });
reset(); hooks.audio = () => new Response(new Uint8Array(0));
await fails('/download?id=abc123', 502, 'AUDIO_EMPTY', { retryable: true });
reset(); hooks.audio = () => new Response('<html>blocked</html>');
await fails('/download?id=abc123', 502, 'INVALID_AUDIO', { retryable: true });
reset(); hooks.audio = () => new Response(SONG.subarray(0, 3000)); // truncated download
await fails('/download?id=abc123', 502, 'INVALID_AUDIO');
reset(); hooks.audio = () => new Response(SONG, { headers: { 'Content-Length': '30000000' } });
await fails('/download?id=abc123', 413, 'FILE_TOO_LARGE', { retryable: false });
assert.equal(calls.upload ?? 0, 0, 'oversized file must never be uploaded');
reset(); hooks.audio = timeout;
await fails('/download?id=abc123', 504, 'UPSTREAM_TIMEOUT', { retryable: true });
console.log('PASS audio errors');

// ================= Telegram upload =================
const up = (status, desc, extra) => () => tgErr(status, desc, extra);
reset(); hooks.upload = up(401, 'Unauthorized');
await fails('/download?id=abc123', 500, 'TELEGRAM_AUTH', { retryable: false });
reset(); hooks.upload = up(403, 'Forbidden: bot was kicked from the supergroup chat');
await fails('/download?id=abc123', 500, 'TELEGRAM_FORBIDDEN');
reset(); hooks.upload = up(400, 'Bad Request: chat not found');
await fails('/download?id=abc123', 500, 'TELEGRAM_CHAT_NOT_FOUND');
reset(); hooks.upload = up(400, 'Bad Request: group chat was upgraded to a supergroup chat', { parameters: { migrate_to_chat_id: -100999 } });
assert.match((await fails('/download?id=abc123', 500, 'TELEGRAM_CHAT_MIGRATED')).body.message, /-100999/);
reset(); hooks.upload = up(400, 'Bad Request: something odd');
await fails('/download?id=abc123', 502, 'TELEGRAM_BAD_REQUEST');
reset(); hooks.upload = up(413, 'Request Entity Too Large');
await fails('/download?id=abc123', 413, 'FILE_TOO_LARGE');
reset(); hooks.upload = up(502, 'Bad Gateway');
await fails('/download?id=abc123', 502, 'TELEGRAM_UNAVAILABLE', { retryable: true });
assert.equal(calls.upload, 1, 'only rate limits are retried (a retry could double-post)');
reset(); hooks.upload = () => new Response('<html>Bad gateway</html>', { status: 502 });
await fails('/download?id=abc123', 502, 'TELEGRAM_BAD_RESPONSE', { retryable: true });
reset(); hooks.upload = () => { throw new TypeError('fetch failed'); };
await fails('/download?id=abc123', 502, 'UPSTREAM_UNREACHABLE');
reset(); hooks.upload = () => Response.json({ ok: true, result: { message_id: 1 } });
await fails('/download?id=abc123', 502, 'TELEGRAM_BAD_RESPONSE');

// rate limited once -> retried and succeeds; always rate limited -> 503 with Retry-After
reset(); let n = 0;
hooks.upload = () => (n++ === 0 ? tgErr(429, 'Too Many Requests', { parameters: { retry_after: 0 } }) : undefined);
assert.equal((await get('/download?id=abc123')).status, 200);
assert.equal(calls.upload, 2);
reset(); hooks.upload = up(429, 'Too Many Requests', { parameters: { retry_after: 0 } });
await fails('/download?id=abc123', 503, 'TELEGRAM_RATE_LIMITED', { retryable: true });
assert.equal(calls.upload, 3);

// uploaded but index write fails: the user still gets the file
reset();
const flaky = { prepare: (sql) => (sql.includes('INSERT OR REPLACE INTO tracks') ? { bind: () => ({ run: async () => { throw new Error('D1_ERROR: boom'); } }) } : DB.prepare(sql)) };
r = await get('/download?id=abc123', { ...env, DB: flaky });
assert.equal(r.status, 200);
assert.equal(calls.upload, 1);
console.log('PASS telegram upload errors');

// ================= serving stored tracks =================
const seed = async () => { reset(); await get('/download?id=abc123'); for (const k of Object.keys(calls)) delete calls[k]; };
const rowExists = () => !!sqlite.prepare('SELECT 1 FROM tracks WHERE id=?').get('abc123');

await seed(); hooks.getFile = up(500, 'Internal Server Error');
await fails('/download?id=abc123', 502, 'TELEGRAM_UNAVAILABLE', { retryable: true });
assert.ok(rowExists(), 'temporary Telegram error must not drop the index row');
assert.equal(calls.upload ?? 0, 0, 'temporary Telegram error must not trigger a rebuild');

await seed(); hooks.getFile = up(400, 'Bad Request: file is too big');
await fails('/download?id=abc123', 413, 'FILE_TOO_LARGE');
assert.ok(rowExists());
assert.equal(calls.upload ?? 0, 0, 'oversized stored file must not be re-uploaded in a loop');

await seed(); hooks.getFile = up(401, 'Unauthorized');
await fails('/download?id=abc123', 500, 'TELEGRAM_AUTH');
assert.ok(rowExists());

await seed(); hooks.getFile = timeout;
await fails('/download?id=abc123', 504, 'UPSTREAM_TIMEOUT');
assert.ok(rowExists());

await seed(); hooks.getFile = () => new Response('<html>', { status: 502 });
await fails('/download?id=abc123', 502, 'TELEGRAM_BAD_RESPONSE');
assert.ok(rowExists());

await seed(); hooks.tgDownload = () => new Response('x', { status: 500 });
await fails('/download?id=abc123', 502, 'TELEGRAM_UNAVAILABLE');
assert.ok(rowExists());
assert.equal(calls.upload ?? 0, 0);

await seed(); hooks.tgDownload = () => { throw new TypeError('fetch failed'); };
await fails('/download?id=abc123', 502, 'TELEGRAM_UNREACHABLE');
assert.ok(rowExists());

await seed(); hooks.tgDownload = () => new Response('gone', { status: 404 }); // definitively gone -> rebuild
r = await get('/download?id=abc123');
assert.equal(r.status, 200);
assert.equal(calls.upload, 1);
console.log('PASS serving errors');

// ================= job / concurrency failures =================
reset(); hooks.saavn = () => Response.json({ success: false }, { status: 404 });
const both = await Promise.all([get('/download?id=abc123'), get('/download?id=abc123')]);
both.forEach((x) => assert.equal(x.status, 404));
assert.equal(calls.saavn, 1);

// another isolate's live job that then dies -> BUILD_INTERRUPTED; stale job gets taken over
reset();
sqlite.prepare(`INSERT INTO jobs VALUES ('abc123','processing',NULL,?)`).run(Date.now());
setTimeout(() => sqlite.exec('DELETE FROM jobs'), 100);
r = await get('/download?id=abc123');
assert.equal(r.status, 503);
assert.equal((await r.json()).code, 'BUILD_INTERRUPTED');
assert.equal(r.headers.get('Retry-After'), '5');
reset();
sqlite.prepare(`INSERT INTO jobs VALUES ('abc123','processing',NULL,?)`).run(Date.now() - 10 * 60 * 1000);
assert.equal((await get('/download?id=abc123')).status, 200, 'stale job is taken over');

// another isolate finishes the build while we wait
reset();
sqlite.prepare(`INSERT INTO jobs VALUES ('abc123','processing',NULL,?)`).run(Date.now());
setTimeout(() => sqlite.prepare(`INSERT INTO tracks VALUES ('abc123','FILEID_X',1,'a.m4a','1.00','t','a','al',?)`).run(Date.now()), 300);
tgStore.set('FILEID_X', new Uint8Array([1, 2, 3]));
r = await get('/download?id=abc123');
assert.equal(r.status, 200);
assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([1, 2, 3]));

// old-format failure rows (plain text) are still understood
reset();
sqlite.prepare(`INSERT INTO jobs VALUES ('abc123','failed','Track not found',?)`).run(Date.now());
assert.equal((await (await get('/status?id=abc123')).json()).code, 'BUILD_FAILED');

// unexpected exceptions become a safe 500 with the token redacted; D1 failures get their own code
reset();
const boom = (msg) => ({ prepare: () => { throw new Error(msg); } });
{
  const { body } = await fails('/download?id=abc123', 500, 'INTERNAL_ERROR', { retryable: true, e: { ...env, DB: boom('weird failure 123:SECRET') } });
  assert.match(body.detail, /weird failure \*\*\*/);
}
await fails('/download?id=abc123', 500, 'DB_ERROR', { retryable: true, e: { ...env, DB: boom('D1_ERROR: database is locked') } });
// a failure while recording a failure must not mask the original error
reset(); hooks.saavn = () => Response.json({ success: false }, { status: 404 });
const noJobWrite = { prepare: (sql) => (sql.startsWith('UPDATE jobs') ? { bind: () => ({ run: async () => { throw new Error('D1_ERROR: x'); } }) } : DB.prepare(sql)) };
await fails('/download?id=abc123', 404, 'TRACK_NOT_FOUND', { e: { ...env, DB: noJobWrite } });
console.error = realError;
console.log('PASS job / concurrency errors');
console.log('PASS worker end-to-end');
