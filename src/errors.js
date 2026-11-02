/** An error with a stable machine-readable code, an HTTP status, and a retry hint. */
export class AppError extends Error {
  constructor(code, message, { status = 500, retryable = false, retryAfter, cause } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    if (cause) this.cause = cause;
  }
}

/** Turn anything thrown into an AppError (D1 problems get friendly messages). */
export function toAppError(e) {
  if (e instanceof AppError) return e;
  const msg = String(e?.message ?? e ?? 'Unknown error');
  if (/no such table/i.test(msg)) {
    return new AppError('DB_NOT_INITIALIZED', 'Database tables are missing. Run schema.sql on the D1 database.', { status: 500, cause: e });
  }
  if (/^D1_/.test(msg) || e?.name === 'D1_ERROR') {
    return new AppError('DB_ERROR', 'Database error. Please try again.', { status: 500, retryable: true, cause: e });
  }
  const err = new AppError('INTERNAL_ERROR', 'Unexpected internal error', { status: 500, retryable: true, cause: e });
  err.detail = msg.slice(0, 200);
  return err;
}

// Failures are stored in the jobs table as JSON so /status can report them (no schema change needed).
export const serializeError = (err) =>
  JSON.stringify({ code: err.code, message: err.message, status: err.status, retryable: err.retryable });

export function deserializeError(text) {
  try {
    const o = JSON.parse(text);
    if (o && o.code) return new AppError(o.code, o.message, { status: o.status ?? 502, retryable: !!o.retryable });
  } catch {}
  return new AppError('BUILD_FAILED', String(text || 'Build failed'), { status: 502, retryable: true });
}
