// Pure-JS MP4/M4A tag writer. No encoding, no ffmpeg: it only rewrites the
// container's metadata (moov/udta/meta/ilst) and leaves the audio bytes alone.

const te = new TextEncoder();

// Four-character code -> bytes. Uses char codes so that "©" becomes 0xA9.
const fourcc = (s) => Uint8Array.from([0, 1, 2, 3].map((i) => s.charCodeAt(i)));
const readType = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

const u32 = (n) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function box(type, ...payloads) {
  let len = 8;
  for (const p of payloads) len += p.length;
  const out = new Uint8Array(len);
  out.set(u32(len), 0);
  out.set(fourcc(type), 4);
  let o = 8;
  for (const p of payloads) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function parseBoxes(u8, start = 0, end = u8.length) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = readType(u8, p + 4);
    let hdr = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) throw new Error(`Corrupt MP4: bad "${type}" box at byte ${p}`);
    boxes.push({ type, start: p, end: p + size, hdr });
    p += size;
  }
  return boxes;
}

// ---------- ilst (iTunes-style metadata) ----------

const FLAG_UTF8 = 1;
const FLAG_JPEG = 13;
const FLAG_PNG = 14;

function dataBox(flag, payload) {
  return box('data', Uint8Array.from([0, 0, 0, flag, 0, 0, 0, 0]), payload);
}
const textItem = (key, value) => box(key, dataBox(FLAG_UTF8, te.encode(String(value))));

function coverFlag(img) {
  if (img[0] === 0xff && img[1] === 0xd8) return FLAG_JPEG;
  if (img[0] === 0x89 && img[1] === 0x50 && img[2] === 0x4e && img[3] === 0x47) return FLAG_PNG;
  return 0; // unsupported (e.g. WebP) - cover is skipped rather than corrupting the file
}

function buildUdta(meta) {
  const items = [];
  const add = (key, v) => {
    if (v !== undefined && v !== null && String(v) !== '') items.push(textItem(key, v));
  };
  add('\u00a9nam', meta.title);
  add('\u00a9ART', meta.artist);
  add('aART', meta.albumArtist ?? meta.artist);
  add('\u00a9alb', meta.album);
  add('\u00a9day', meta.year);
  add('\u00a9cmt', meta.comment);
  add('cprt', meta.copyright);
  if (meta.cover && meta.cover.length) {
    const flag = coverFlag(meta.cover);
    if (flag) items.push(box('covr', dataBox(flag, meta.cover)));
  }
  const hdlr = box(
    'hdlr',
    new Uint8Array(8), // version/flags + pre_defined
    fourcc('mdir'),
    fourcc('appl'),
    new Uint8Array(9), // 2 reserved words (minus 'appl') + empty name
  );
  const meta_ = box('meta', new Uint8Array(4), hdlr, box('ilst', ...items));
  return box('udta', meta_);
}

// ---------- ftyp ----------

function buildFtyp(u8, b) {
  const p = b.start + b.hdr;
  const major = readType(u8, p);
  if (major === 'M4A ') return null; // already correct
  const brands = [];
  for (let i = p + 8; i + 4 <= b.end; i += 4) brands.push(readType(u8, i));
  const list = [...new Set(['M4A ', 'mp42', 'isom', major, ...brands])];
  return box('ftyp', fourcc('M4A '), u32(0), ...list.map(fourcc));
}

// ---------- moov rewriting (with chunk-offset fix-up) ----------

const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'stbl']);

function patchBox(u8, b, mapOffset) {
  if (CONTAINERS.has(b.type)) {
    const kids = parseBoxes(u8, b.start + b.hdr, b.end).map((c) => patchBox(u8, c, mapOffset));
    return box(b.type, ...kids);
  }
  if (b.type === 'stco' || b.type === 'co64') {
    const out = u8.slice(b.start, b.end);
    const dv = new DataView(out.buffer);
    const count = dv.getUint32(b.hdr + 4);
    let p = b.hdr + 8;
    for (let i = 0; i < count; i++) {
      if (b.type === 'stco') {
        const v = mapOffset(dv.getUint32(p));
        if (v > 0xffffffff) throw new Error('File too large for 32-bit chunk offsets');
        dv.setUint32(p, v);
        p += 4;
      } else {
        dv.setBigUint64(p, BigInt(mapOffset(Number(dv.getBigUint64(p)))));
        p += 8;
      }
    }
    return out;
  }
  return u8.subarray(b.start, b.end);
}

function buildMoov(u8, moov, udta, mapOffset) {
  const kids = parseBoxes(u8, moov.start + moov.hdr, moov.end)
    .filter((c) => c.type !== 'udta') // drop every old tag
    .map((c) => patchBox(u8, c, mapOffset));
  return box('moov', ...kids, udta);
}

/**
 * @param {Uint8Array} input  .mp4 / .m4a bytes (AAC in an MP4 container)
 * @param {{title,artist,albumArtist?,album,year,comment,copyright,cover?:Uint8Array}} meta
 * @returns {Uint8Array} the same audio with new tags + cover art, ready to be named .m4a
 */
export function tagM4A(input, meta) {
  const top = parseBoxes(input);
  const ftypBox = top.find((b) => b.type === 'ftyp');
  const moovBox = top.find((b) => b.type === 'moov');
  if (!ftypBox || !moovBox || !top.some((b) => b.type === 'mdat')) {
    throw new Error('Input is not a valid MP4/M4A file');
  }

  const udta = buildUdta(meta);
  const newFtyp = buildFtyp(input, ftypBox);

  // Pass 1: learn the new moov size (it does not depend on offset values).
  const sizeProbe = buildMoov(input, moovBox, udta, (o) => o);

  // Lay out the new file and remember where every original top-level box moved.
  const layout = [];
  let pos = 0;
  for (const b of top) {
    let len = b.end - b.start;
    if (b === ftypBox && newFtyp) len = newFtyp.length;
    if (b === moovBox) len = sizeProbe.length;
    layout.push({ b, oldStart: b.start, oldEnd: b.end, newStart: pos, len });
    pos += len;
  }
  const mapOffset = (o) => {
    for (const t of layout) if (o >= t.oldStart && o < t.oldEnd) return o - t.oldStart + t.newStart;
    return o;
  };

  // Pass 2: real moov with shifted stco/co64 entries.
  const moov = buildMoov(input, moovBox, udta, mapOffset);

  const out = new Uint8Array(pos);
  for (const t of layout) {
    const bytes =
      t.b === ftypBox && newFtyp ? newFtyp : t.b === moovBox ? moov : input.subarray(t.b.start, t.b.end);
    out.set(bytes, t.newStart);
  }
  return out;
}
