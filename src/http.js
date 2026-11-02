import { AppError } from './errors.js';

// Telegram bots can download at most 20 MB, so anything bigger could be uploaded but never served again.
export const MAX_FILE_BYTES = 20_000_000;

export function networkError(e, label) {
  if (e instanceof AppError) return e;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new AppError('UPSTREAM_TIMEOUT', `${label} timed out`, { status: 504, retryable: true, cause: e });
  }
  return new AppError('UPSTREAM_UNREACHABLE', `${label} is unreachable`, { status: 502, retryable: true, cause: e });
}

/** fetch() with a timeout; network failures become AppErrors. */
export async function safeFetch(url, init = {}, { timeoutMs = 20000, label = 'Upstream' } = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw networkError(e, label);
  }
}

const mb = (n) => (n / 1e6).toFixed(1);

/** Read a response body, refusing anything over maxBytes. */
export async function readBytes(res, { label, maxBytes }) {
  const declared = Number(res.headers.get('Content-Length'));
  if (maxBytes && declared > maxBytes) {
    res.body?.cancel().catch(() => {});
    throw tooLarge(declared, maxBytes);
  }
  let buf;
  try {
    buf = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw networkError(e, label);
  }
  if (maxBytes && buf.length > maxBytes) throw tooLarge(buf.length, maxBytes);
  return buf;
}

export const tooLarge = (size, max = MAX_FILE_BYTES) =>
  new AppError('FILE_TOO_LARGE', `File is ${mb(size)} MB; the limit is ${mb(max)} MB (Telegram bots cannot download larger files)`, { status: 413 });
