import { fetchSong, downloadAudio, downloadCover } from './saavn.js';
import { tagM4A } from './mp4tags.js';
import * as tg from './telegram.js';
import { AppError, toAppError, serializeError, deserializeError } from './errors.js';
import { MAX_FILE_BYTES, tooLarge } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const JOB_STALE_MS = 3 * 60 * 1000;
const PERMANENT_FAILURE_COOLDOWN_MS = 60 * 1000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
};

// Builds already running in this isolate (other isolates are covered by the `jobs` table).
const inflight = new Map();

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });

const redact = (env, s) => (env?.TELEGRAM_TOKEN ? String(s ?? '').split(env.TELEGRAM_TOKEN).join('***') : String(s ?? ''));

// ---------- errors ----------

function errorResponse(env, e) {
  const err = toAppError(e);
  (err.status >= 500 ? console.error : console.warn)(`[${err.code}] ${redact(env, err.message)}`, err.cause ?? '');
  const body = { status: 'Failed', code: err.code, message: redact(env, err.message), retryable: err.retryable };
  if (err.detail) body.detail = redact(env, err.detail);
  const extra = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
  return json(body, err.status, extra);
}

function assertConfig(env) {
  const missing = [];
  if (!env.DB) missing.push('DB (D1 binding)');
  if (!env.TELEGRAM_TOKEN) missing.push('TELEGRAM_TOKEN');
  if (!env.GROUP_ID) missing.push('GROUP_ID');
  if (missing.length) throw new AppError('CONFIG_ERROR', `Server misconfigured: missing ${missing.join(', ')}`, { status: 500 });
}

// ---------- D1 helpers ----------

const getTrack = (env, id) => env.DB.prepare('SELECT * FROM tracks WHERE id = ?').bind(id).first();
const getJob = (env, id) => env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
const isLive = (job) => job && job.state === 'processing' && Date.now() - job.updated_at < JOB_STALE_MS;

// A recent failure that retrying cannot fix (e.g. track not found) is answered from the job row,
// so repeated requests don't hammer the upstream services.
function cachedFailure(job) {
  if (job?.state !== 'failed' || Date.now() - job.updated_at >= PERMANENT_FAILURE_COOLDOWN_MS) return null;
  const err = deserializeError(job.error);
  return err.retryable ? null : err;
}

async function claimJob(env, id) {
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO jobs (id, state, error, updated_at) VALUES (?1, 'processing', NULL, ?2)
     ON CONFLICT(id) DO UPDATE SET state = 'processing', error = NULL, updated_at = ?2
     WHERE jobs.state != 'processing' OR jobs.updated_at < ?3`,
  )
    .bind(id, now, now - JOB_STALE_MS)
    .run();
  return res.meta.changes > 0;
}

async function recordFailure(env, id, err) {
  try {
    await env.DB.prepare(`UPDATE jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .bind(redact(env, serializeError(err)), Date.now(), id)
      .run();
  } catch (e) {
    console.error(`could not record failure for ${id}:`, e);
  }
}

async function saveTrack(env, r) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO tracks (id, file_id, message_id, file_name, size_mb, title, artist, album, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(r.id, r.file_id, r.message_id, r.file_name, r.size_mb, r.title, r.artist, r.album, r.created_at)
        .run();
      return true;
    } catch (e) {
      console.error(`index write failed for ${r.id} (attempt ${attempt + 1}):`, e);
    }
  }
  console.error(`INDEX_WRITE_FAILED: ${r.id} is in Telegram (file_id ${r.file_id}) but not indexed`);
  return false;
}

// ---------- build pipeline ----------

const safeName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180);

async function buildTrack(env, id) {
  const song = await fetchSong(env, id);
  const [audio, cover] = await Promise.all([downloadAudio(song.downloadUrl), downloadCover(song.coverUrl)]);

  // Retag only - the audio stream is untouched; the .mp4 simply becomes .m4a.
  let bytes;
  try {
    bytes = tagM4A(audio, { ...song, cover });
  } catch (e) {
    throw new AppError('INVALID_AUDIO', 'Downloaded audio could not be processed (corrupt or unsupported MP4)', { status: 502, retryable: true, cause: e });
  }
  if (bytes.length > MAX_FILE_BYTES) throw tooLarge(bytes.length);

  const fileName = safeName(`${song.title} - ${song.artist}.m4a`);
  const up = await tg.uploadFile(env, bytes, fileName, `${song.title} - ${song.artist}\nid: ${id}`);

  const record = {
    id,
    file_id: up.file_id,
    message_id: up.message_id,
    file_name: fileName,
    size_mb: (bytes.length / 1048576).toFixed(2),
    title: song.title,
    artist: song.artist,
    album: song.album,
    created_at: Date.now(),
  };
  await saveTrack(env, record); // best effort: we still have the bytes to serve
  return { record, bytes };
}

async function waitForTrack(env, id) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const record = await getTrack(env, id);
    if (record) return { record, bytes: null };
    const job = await getJob(env, id);
    if (job?.state === 'failed') throw deserializeError(job.error);
    if (!isLive(job)) {
      throw new AppError('BUILD_INTERRUPTED', 'The build for this track was interrupted. Please try again.', { status: 503, retryable: true, retryAfter: 5 });
    }
  }
  throw new AppError('BUILD_TIMEOUT', 'Timed out waiting for this track to finish building. Please try again.', { status: 504, retryable: true, retryAfter: 5 });
}

async function runBuild(env, id) {
  const cached = cachedFailure(await getJob(env, id));
  if (cached) throw cached;
  if (!(await claimJob(env, id))) return waitForTrack(env, id); // another isolate is on it
  try {
    const out = await buildTrack(env, id);
    await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run().catch((e) => console.error('job cleanup failed:', e));
    return out;
  } catch (e) {
    const err = toAppError(e);
    console.error(`build ${id} failed [${err.code}]:`, err.message, err.cause ?? '');
    await recordFailure(env, id, err);
    throw err;
  }
}

function ensureTrack(env, id) {
  let p = inflight.get(id);
  if (!p) {
    p = runBuild(env, id).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

// ---------- serving ----------

function disposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function audioHeaders(name, inline, length) {
  const h = {
    'Content-Type': 'audio/mp4',
    'Content-Disposition': disposition(name, inline),
    'Cache-Control': 'public, max-age=86400',
    ...CORS,
  };
  if (length) h['Content-Length'] = String(length);
  return h;
}

// Stream a stored track from Telegram.
// Returns null only if Telegram DEFINITELY no longer has the file; temporary errors throw (no rebuild).
async function serveFromTelegram(env, rec, inline) {
  const path = await tg.getFilePath(env, rec.file_id);
  if (!path) return null;
  const up = await tg.fetchFile(env, path);
  if (up.status === 404) return null;
  if (!up.ok) {
    up.body?.cancel().catch(() => {});
    throw new AppError('TELEGRAM_UNAVAILABLE', `Telegram file server returned ${up.status}`, { status: 502, retryable: true });
  }
  return new Response(up.body, { headers: audioHeaders(rec.file_name, inline, up.headers.get('Content-Length')) });
}

async function handleDownload(env, id, inline) {
  const rec = await getTrack(env, id);
  if (rec) {
    const res = await serveFromTelegram(env, rec, inline);
    if (res) return res; // found in the Telegram group: no re-download / re-tagging
    console.warn(`track ${id}: file is gone from Telegram, rebuilding`);
    await env.DB.prepare('DELETE FROM tracks WHERE id = ?').bind(id).run();
  }
  const { record, bytes } = await ensureTrack(env, id);
  if (bytes) return new Response(bytes, { headers: audioHeaders(record.file_name, inline, bytes.length) });
  const res = await serveFromTelegram(env, record, inline);
  if (!res) throw new AppError('STORED_FILE_UNAVAILABLE', 'Track was built but could not be read back from Telegram', { status: 502, retryable: true });
  return res;
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'GET') {
        return json({ status: 'Failed', code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported', retryable: false }, 405, { Allow: 'GET, OPTIONS' });
      }

      const url = new URL(request.url);
      if (url.pathname === '/') return new Response('Hello World !! Made by https://koshik.pages.dev', { headers: CORS });
      if (!['/add', '/status', '/download'].includes(url.pathname)) {
        return json({ status: 'Failed', code: 'NOT_FOUND', message: 'Unknown endpoint', retryable: false }, 404);
      }

      assertConfig(env);
      const id = url.searchParams.get('id');
      if (!id) throw new AppError('MISSING_ID', 'No id provided', { status: 400 });
      if (!ID_RE.test(id)) throw new AppError('INVALID_ID', 'Invalid id (letters, digits, "-" and "_" only, max 40)', { status: 400 });

      switch (url.pathname) {
        case '/add': {
          if (await getTrack(env, id)) return json({ status: 'success', cached: true });
          const job = await getJob(env, id);
          const failed = cachedFailure(job);
          if (failed) throw failed;
          if (!isLive(job)) ctx.waitUntil(ensureTrack(env, id).catch(() => {})); // failure is stored in the job row
          return json({ status: 'success' });
        }
        case '/status': {
          const rec = await getTrack(env, id);
          if (rec) return json({ status: 'Done', url: `/download?id=${id}`, size: rec.size_mb });
          const job = await getJob(env, id);
          if (isLive(job)) return json({ status: 'Compiling', size: 'Null' });
          if (job?.state === 'failed') {
            const err = deserializeError(job.error);
            return json({ status: 'Failed', code: err.code, message: redact(env, err.message), retryable: err.retryable });
          }
          return json({ status: 'Not in queue' });
        }
        default:
          return await handleDownload(env, id, url.searchParams.has('inline'));
      }
    } catch (e) {
      return errorResponse(env, e);
    }
  },
};
