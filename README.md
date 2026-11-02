# musicserver (Cloudflare Workers)

Fetches a track, rewrites its tags + cover art, stores it in a Telegram group and serves it.

- **No ffmpeg, no MP3 encoding.** The `.mp4` audio, served by JioSaavn, is untouched; only the metadata atoms are rewritten
  (title, artist, album artist, album, year, comment, copyright, cover art) and the file is served as `.m4a`.
- **Telegram is the file store.** Every built track is uploaded to your group (caption contains `id: <track-id>`).
- **Cache check first.** `/download` looks the id up; if it is already in the group it streams it from Telegram
  without re-downloading or re-tagging. Otherwise it builds, uploads, and serves.
- **Nothing is lost on restart/redeploy/commit.** Files live in Telegram, the id → `file_id` index lives in D1.

## Setup

```bash
npm install
npx wrangler d1 create musicserver          # copy the database_id into wrangler.toml
npm run db:init                             # creates the tables (safe to re-run)
npx wrangler secret put TELEGRAM_TOKEN      # from BotFather
npx wrangler secret put GROUP_ID            # e.g. -1001234567890 (bot must be in the group, allowed to post)
npm run deploy
```

Required variables:
```
TELEGRAM_TOKEN="123456:your_telegram_token"
GROUP_ID="-10012345678"
```
Optional var `SAAVN_API` overrides the metadata API URL.

### Other method for setup

- Create a new worker in cloudflare 
- Import this repo and deploy
- In workers > settings > add variables
- Make the bot admin of that group (telegram)

## Endpoints

| Endpoint | Behaviour |
|---|---|
| `/add?id=ID` | Starts a build in the background (no-op if already stored). |
| `/status?id=ID` | `Done` (+ `url`, `size` MB) / `Compiling` / `Failed` / `Not in queue`. |
| `/download?id=ID` | Serves the `.m4a` (add `&inline=1` to play instead of download). Builds first if missing. |

## Errors

Every failure returns JSON: `{"status":"Failed","code":"...","message":"...","retryable":true|false}` with a matching
HTTP status (`Retry-After` is set for rate limits). `/status` reports a failed build with the same `code`.
Secrets are never included in messages.

| Code | HTTP | Retry? | Meaning / fix |
|---|---|---|---|
| `MISSING_ID`, `INVALID_ID` | 400 | no | Bad `id` parameter. |
| `METHOD_NOT_ALLOWED`, `NOT_FOUND` | 405 / 404 | no | Wrong method or endpoint. |
| `CONFIG_ERROR` | 500 | no | Missing `DB` binding, `TELEGRAM_TOKEN` or `GROUP_ID`, or invalid `SAAVN_API`. |
| `DB_NOT_INITIALIZED` | 500 | no | Run `schema.sql` on the D1 database. |
| `DB_ERROR`, `INTERNAL_ERROR` | 500 | yes | Database or unexpected error (details in Worker logs). |
| `TRACK_NOT_FOUND` | 404 | no | The metadata API does not know this id. |
| `NO_DOWNLOAD_URL` | 422 | no | Track exists but has no audio. |
| `METADATA_API_BLOCKED` | 502 | no | Error 1042: enable `global_fetch_strictly_public` (already in `wrangler.toml`). |
| `METADATA_API_ERROR`, `METADATA_API_INVALID`, `METADATA_API_RATE_LIMITED` | 502 / 503 | mostly | Metadata API down, wrong URL (404), bad response, or rate limited. |
| `AUDIO_UNAVAILABLE`, `AUDIO_SERVER_ERROR`, `AUDIO_RATE_LIMITED`, `AUDIO_EMPTY` | 502 / 503 | yes | Audio CDN problems (expired link, outage, empty file). |
| `INVALID_AUDIO` | 502 | yes | Downloaded file was not a valid MP4 (truncated, or an error page). |
| `FILE_TOO_LARGE` | 413 | no | Over 20 MB; Telegram bots cannot download bigger files, so it is refused before upload. |
| `TELEGRAM_AUTH` | 500 | no | Bad `TELEGRAM_TOKEN`. |
| `TELEGRAM_FORBIDDEN`, `TELEGRAM_CHAT_NOT_FOUND`, `TELEGRAM_CHAT_MIGRATED` | 500 | no | Bot removed/not allowed, wrong `GROUP_ID`, or group upgraded (message gives the new id). |
| `TELEGRAM_RATE_LIMITED`, `TELEGRAM_UNAVAILABLE`, `TELEGRAM_UNREACHABLE`, `TELEGRAM_BAD_RESPONSE` | 502 / 503 | yes | Temporary Telegram trouble. |
| `UPSTREAM_TIMEOUT`, `UPSTREAM_UNREACHABLE` | 504 / 502 | yes | A network call timed out or failed. |
| `BUILD_INTERRUPTED`, `BUILD_TIMEOUT` | 503 / 504 | yes | Another request was building this track and did not finish. |

Behaviour worth knowing:

- A temporary Telegram error while serving a stored track **never** deletes the index row or rebuilds the track.
  Only a definitive "file no longer exists" does.
- Only upload rate limits are retried automatically, because retrying other failures could post the file twice.
- Permanent failures (e.g. `TRACK_NOT_FOUND`) are remembered for 60 s so repeated requests do not hit the upstream APIs.
- If the upload succeeds but the index write fails, the file is still served and the problem is logged.
- A failure after streaming has started cannot change the HTTP status; the connection simply ends early.
- If `DB_NOT_INITIALIZED` error occurs, then run `schema.sql` on **Cloudflare dashboard → Storage & Databases → D1 → {db_name} → Console**. _If it accepts only one statement at a time, run the two `CREATE TABLE` statements separately._

## Tests

`npm test` (needs `ffmpeg` only to generate test fixtures). Verifies tags, cover, bit-identical audio and
chunk-offset fix-up for both `moov`-first and `moov`-last files, plus the full cache/build/upload flow.

The `test` directory/folder can be removed anytime. After removing the folder remember to delete the following line from `package.json`
```
"test": "node test/mp4tags.test.mjs && node --no-warnings test/worker.test.mjs"
```

## Notes

- The Bot API cannot search group history, so the D1 table is the lookup index. If the table were ever wiped,
  the files are still in the group (searchable by `id:`), but they would be re-built on next request.
- Bots can download files up to 20 MB from Telegram - fine for songs.
- Free plan: use a Workers **Paid** plan if tagging a large file exceeds the 10 ms CPU limit; `/add` background work is
  limited to ~30 s after the response (use `/download` directly for slow builds).
- The old express rate limiter is gone; add a Cloudflare WAF rate-limiting rule for `/add` and `/download`.
- ONLY WORKS FOR JSON RESPONSE FROM THIS [API](https://jiosaavnsearch-up.koshikkumar17.workers.dev). IF API IS CHANGED, CODE NEEDS TO BE ADAPTED ACCORDING TO THAT.

## Copyright & Credits
Developed by **[Koshik Kumar](https://github.com/KoshikKumar17)**

This code was licensed under MIT License. View [LICENSE FILE](./LICENSE)

### Special thanks

 **[@sumitkolhe](https://github.com/sumitkolhe)** for [jiosaavn-api](https://github.com/sumitkolhe/jiosaavn-api)

 **[@wiz64](https://github.com/wiz64)** for [saadhna-mp3-server](https://github.com/wiz64/saadhna-mp3-server)

• **Claude AI**

I am not responsible for any Third-Party Copyright Material, We do not host any copyrighted material on our servers or accounts.

> &copy;  Copyright 2026 @KoshikKumar17
