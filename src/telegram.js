import { AppError } from './errors.js';
import { safeFetch } from './http.js';

const api = (env, method) => `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function parse(r) {
  const text = await r.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mapError(status, j) {
  const desc = j?.description ?? '';
  const retryAfter = j?.parameters?.retry_after;
  if (status === 401) return new AppError('TELEGRAM_AUTH', 'Telegram rejected the bot token. Check TELEGRAM_TOKEN.', { status: 500 });
  if (status === 403) return new AppError('TELEGRAM_FORBIDDEN', 'The bot is not allowed to post in the group (removed, blocked, or no permission).', { status: 500 });
  if (status === 413 || /too (big|large)/i.test(desc)) return new AppError('FILE_TOO_LARGE', 'File is too large for Telegram bots', { status: 413 });
  if (status === 429) return new AppError('TELEGRAM_RATE_LIMITED', 'Telegram is rate limiting the bot', { status: 503, retryable: true, retryAfter: retryAfter ?? 5 });
  if (j?.parameters?.migrate_to_chat_id) {
    return new AppError('TELEGRAM_CHAT_MIGRATED', `The group was upgraded to a supergroup. Set GROUP_ID to ${j.parameters.migrate_to_chat_id}.`, { status: 500 });
  }
  if (/chat not found|PEER_ID_INVALID/i.test(desc)) {
    return new AppError('TELEGRAM_CHAT_NOT_FOUND', 'Telegram chat not found. Check GROUP_ID and that the bot is in the group.', { status: 500 });
  }
  if (status >= 500) return new AppError('TELEGRAM_UNAVAILABLE', 'Telegram is temporarily unavailable', { status: 502, retryable: true });
  return new AppError('TELEGRAM_BAD_REQUEST', `Telegram rejected the request: ${desc || status}`, { status: 502 });
}

/** Upload bytes to the group as a document (kept byte-for-byte). Returns {file_id, message_id}. */
export async function uploadFile(env, bytes, fileName, caption) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('chat_id', env.GROUP_ID);
    form.append('caption', caption);
    form.append('document', new Blob([bytes], { type: 'audio/mp4' }), fileName);
    const r = await safeFetch(api(env, 'sendDocument'), { method: 'POST', body: form }, { label: 'Telegram', timeoutMs: 90000 });
    const j = await parse(r);
    if (r.ok && j?.ok) {
      const f = j.result?.document ?? j.result?.audio;
      if (!f?.file_id) throw new AppError('TELEGRAM_BAD_RESPONSE', 'Telegram accepted the upload but returned no file id', { status: 502, retryable: true });
      return { file_id: f.file_id, message_id: j.result.message_id };
    }
    if (!j) throw new AppError('TELEGRAM_BAD_RESPONSE', `Telegram returned an unreadable response (HTTP ${r.status})`, { status: 502, retryable: true });
    const err = mapError(r.status, j);
    // Only rate limits are retried: any other failure might mean the file was already posted.
    if (err.code === 'TELEGRAM_RATE_LIMITED' && attempt < 2) {
      await sleep(Math.min(err.retryAfter, 15) * 1000);
      continue;
    }
    throw err;
  }
}

/**
 * Resolve a file_id to a downloadable path.
 * Returns null ONLY when Telegram definitively no longer has the file; temporary problems throw.
 */
export async function getFilePath(env, fileId) {
  const r = await safeFetch(`${api(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`, {}, { label: 'Telegram', timeoutMs: 15000 });
  const j = await parse(r);
  if (r.ok && j?.ok) {
    if (!j.result?.file_path) throw new AppError('TELEGRAM_BAD_RESPONSE', 'Telegram returned no file path', { status: 502, retryable: true });
    return j.result.file_path;
  }
  const desc = j?.description ?? '';
  if (/too (big|large)/i.test(desc)) {
    throw new AppError('FILE_TOO_LARGE', 'Stored file is larger than the 20 MB Telegram bot download limit', { status: 413 });
  }
  if (r.status === 400 && /file_id|wrong file|invalid file|not found/i.test(desc)) return null;
  if (!j) throw new AppError('TELEGRAM_BAD_RESPONSE', `Telegram returned an unreadable response (HTTP ${r.status})`, { status: 502, retryable: true });
  throw mapError(r.status, j);
}

/** Open the file stream. Returns the Response (caller checks 404 = gone). */
export async function fetchFile(env, filePath) {
  try {
    return await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  } catch (e) {
    throw new AppError('TELEGRAM_UNREACHABLE', 'Telegram file server is unreachable', { status: 502, retryable: true, cause: e });
  }
}
