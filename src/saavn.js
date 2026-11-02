import { AppError } from './errors.js';
import { safeFetch, readBytes, MAX_FILE_BYTES } from './http.js';

const DEFAULT_API = 'https://jiosaavnsearch-up.koshikkumar17.workers.dev/api/songs';
const FALLBACK_COVER = 'https://i.ibb.co/Kb7nMgQ/saavn-cli.jpg';
const MAX_COVER_BYTES = 5_000_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s ?? '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const linkOf = (e) => e?.url ?? e?.link;
// Prefer the wanted quality label, otherwise the last (= largest) entry.
function pick(list, wanted) {
  if (!Array.isArray(list) || !list.length) return undefined;
  return linkOf(list.find((e) => e.quality === wanted) ?? list[list.length - 1]);
}

const tryJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export async function fetchSong(env, id) {
  let apiUrl;
  try {
    apiUrl = new URL(env.SAAVN_API || DEFAULT_API);
  } catch (e) {
    throw new AppError('CONFIG_ERROR', 'SAAVN_API is not a valid URL', { status: 500, cause: e });
  }
  apiUrl.searchParams.set('ids', id);

  const r = await safeFetch(apiUrl, { headers: { Accept: 'application/json' } }, { label: 'Metadata API', timeoutMs: 15000 });
  const text = await r.text().catch(() => '');
  const json = tryJson(text);

  if (!r.ok) {
    console.warn(`Metadata API ${r.status} for ${apiUrl}: ${text.slice(0, 150)}`);
    if (/error code: 1042/.test(text)) {
      throw new AppError('METADATA_API_BLOCKED',
        'Metadata API is a Cloudflare Worker and the call was blocked (error 1042). Enable the global_fetch_strictly_public compatibility flag.',
        { status: 502 });
    }
    if ((r.status === 404 || r.status === 400) && json?.success === false) {
      throw new AppError('TRACK_NOT_FOUND', `Track "${id}" was not found`, { status: 404 });
    }
    if (r.status === 404) {
      throw new AppError('METADATA_API_ERROR', 'Metadata API endpoint returned 404. Check the SAAVN_API setting.', { status: 502 });
    }
    if (r.status === 429) {
      throw new AppError('METADATA_API_RATE_LIMITED', 'Metadata API is rate limiting requests', { status: 503, retryable: true, retryAfter: 30 });
    }
    throw new AppError('METADATA_API_ERROR', `Metadata API returned ${r.status}`, { status: 502, retryable: r.status >= 500 });
  }

  if (!json || typeof json !== 'object') {
    throw new AppError('METADATA_API_INVALID', 'Metadata API returned an invalid (non-JSON) response', { status: 502, retryable: true });
  }
  const d = json.data?.[0];
  if (json.success === false || !d) {
    throw new AppError('TRACK_NOT_FOUND', `Track "${id}" was not found`, { status: 404 });
  }

  const downloadUrl = pick(d.downloadUrl, '160kbps');
  // 160kbps; can be set to  12kbps, 48kbps, 96kbps, 160kbps, 320kbps
  if (!downloadUrl) {
    throw new AppError('NO_DOWNLOAD_URL', 'This track has no downloadable audio', { status: 422 });
  }

  return {
    id: d.id ?? id,
    title: decode(d.name) || String(id),
    artist: (d.artists?.primary ?? []).map((a) => decode(a.name)).join(', '),
    album: decode(d.album?.name),
    year: d.year ?? '',
    duration: d.duration,
    copyright: decode(d.copyright),
    comment: d.url ?? '',
    coverUrl: pick(d.image, '500x500'),
    // cover image can be 50×50, 150×150, 500×500
    downloadUrl,
  };
}

export async function downloadAudio(url) {
  const r = await safeFetch(url, {}, { label: 'Audio server', timeoutMs: 60000 });
  if (!r.ok) {
    r.body?.cancel().catch(() => {});
    if (r.status === 429) throw new AppError('AUDIO_RATE_LIMITED', 'Audio server is rate limiting requests', { status: 503, retryable: true, retryAfter: 30 });
    if (r.status >= 500) throw new AppError('AUDIO_SERVER_ERROR', `Audio server returned ${r.status}`, { status: 502, retryable: true });
    throw new AppError('AUDIO_UNAVAILABLE', `Audio file is unavailable (HTTP ${r.status}); the link may have expired`, { status: 502, retryable: true });
  }
  const bytes = await readBytes(r, { label: 'Audio server', maxBytes: MAX_FILE_BYTES });
  if (!bytes.length) throw new AppError('AUDIO_EMPTY', 'Audio server returned an empty file', { status: 502, retryable: true });
  return bytes;
}

// Cover art never aborts a build: fall back to the default image, then to "no cover".
export async function downloadCover(url) {
  for (const u of [url, FALLBACK_COVER]) {
    if (!u) continue;
    try {
      const r = await safeFetch(u, {}, { label: 'Cover server', timeoutMs: 15000 });
      if (!r.ok) {
        r.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${r.status}`);
      }
      return await readBytes(r, { label: 'Cover server', maxBytes: MAX_COVER_BYTES });
    } catch (e) {
      console.warn('Cover download failed:', u, e.message);
    }
  }
  return null;
}
