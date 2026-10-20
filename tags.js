'use strict';

// Song tags (title, artist, album, cover art), so a converted song still shows
// up properly in music players instead of as "Unknown".
//
// Reads: ID3v2.2/2.3/2.4 (MP3, also found at the start of some other files)
// and iTunes-style MP4 tags (M4A/MP4/AAC from iTunes, Apple Music downloads
// aside: those are DRM-protected and can't be decoded at all).
// Writes: ID3v2.3 for MP3 (the version most players read) and a RIFF INFO
// chunk for WAV (title, artist, album; WAV has no common cover-art field).

const Tags = (() => {
  const latin1 = new TextDecoder('latin1');
  const utf8 = new TextDecoder('utf-8');
  const utf16le = new TextDecoder('utf-16le');
  const utf16be = new TextDecoder('utf-16be');

  const clean = (s) => s.replace(/\0+$/, '').split('\0')[0].trim();
  const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
  const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const u24 = (b, i) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];

  /** Undo ID3 unsynchronisation: every 0xFF 0x00 was 0xFF. */
  function unsync(b) {
    const out = new Uint8Array(b.length);
    let n = 0;
    for (let i = 0; i < b.length; i++) {
      out[n++] = b[i];
      if (b[i] === 0xff && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, n);
  }

  /** Text in one of ID3's four encodings. Returns [text, bytes used incl. terminator] when terminated. */
  function text(enc, b, terminated = false) {
    const wide = enc === 1 || enc === 2;
    let end = b.length;
    if (terminated) {
      end = -1;
      for (let i = 0; i + (wide ? 1 : 0) < b.length; i += wide ? 2 : 1) {
        if (b[i] === 0 && (!wide || b[i + 1] === 0)) { end = i; break; }
      }
      if (end < 0) end = b.length;
    }
    const raw = b.subarray(0, end);
    let s;
    if (enc === 0) s = latin1.decode(raw);
    else if (enc === 3) s = utf8.decode(raw);
    else if (enc === 2) s = utf16be.decode(raw);
    else if (raw[0] === 0xfe && raw[1] === 0xff) s = utf16be.decode(raw.subarray(2));
    else s = utf16le.decode(raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2) : raw);
    return terminated ? [s, Math.min(b.length, end + (wide ? 2 : 1))] : clean(s);
  }

  function readId3(b) {
    if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null; // "ID3"
    const major = b[3], flags = b[5];
    if (major < 2 || major > 4) return null;
    let body = b.subarray(10, Math.min(b.length, 10 + syncsafe(b, 6)));
    if (flags & 0x80 && major < 4) body = unsync(body);
    let i = 0;
    if (flags & 0x40 && major === 3) i = 4 + u32(body, 0);
    if (flags & 0x40 && major === 4) i = syncsafe(body, 0);
    const names = major === 2
      ? { TT2: 'title', TP1: 'artist', TAL: 'album', PIC: 'cover' }
      : { TIT2: 'title', TPE1: 'artist', TALB: 'album', APIC: 'cover' };
    const idLen = major === 2 ? 3 : 4, headLen = major === 2 ? 6 : 10;
    const tags = {};
    while (i + headLen <= body.length) {
      const id = latin1.decode(body.subarray(i, i + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding
      const size = major === 2 ? u24(body, i + 3) : major === 4 ? syncsafe(body, i + 4) : u32(body, i + 4);
      const formatFlags = major === 2 ? 0 : body[i + 9];
      let data = body.subarray(i + headLen, i + headLen + size);
      i += headLen + size;
      const key = names[id];
      if (!key || tags[key] || !data.length) continue;
      if (major === 4 && formatFlags & 0x02) data = unsync(data);
      if (major === 4 && formatFlags & 0x01) data = data.subarray(4); // data length indicator
      if (major !== 2 && formatFlags & 0x0c) continue; // compressed or encrypted: skip
      const enc = data[0];
      if (key !== 'cover') {
        const value = text(enc, data.subarray(1));
        if (value) tags[key] = value;
        continue;
      }
      // Cover: v2.2 has a 3-letter format, later versions a MIME type.
      let p = 1, mime;
      if (major === 2) {
        const format = latin1.decode(data.subarray(1, 4)).toUpperCase();
        mime = format === 'PNG' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        const z = data.indexOf(0, 1);
        if (z < 0) continue;
        mime = latin1.decode(data.subarray(1, z)).toLowerCase() || 'image/jpeg';
        if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
        p = z + 1;
      }
      p += 1; // picture type
      p += text(enc, data.subarray(p), true)[1]; // description
      const image = data.subarray(p);
      if (image.length) tags.cover = { mime, data: image.slice() };
    }
    return tags;
  }

  /** iTunes-style tags: moov > udta > meta > ilst > ©nam / ©ART / ©alb / covr > data. */
  function readMp4(b) {
    const boxes = (start, end) => {
      const out = [];
      for (let i = start; i + 8 <= end;) {
        let size = u32(b, i), head = 8;
        const type = latin1.decode(b.subarray(i + 4, i + 8));
        if (size === 1) { size = u32(b, i + 8) * 2 ** 32 + u32(b, i + 12); head = 16; }
        else if (size === 0) size = end - i;
        if (size < head || i + size > end) break;
        out.push({ type, start: i + head, end: i + size });
        i += size;
      }
      return out;
    };
    if (b.length < 12 || latin1.decode(b.subarray(4, 8)) !== 'ftyp') return null;
    const find = (list, type) => list.find((x) => x.type === type);
    const moov = find(boxes(0, b.length), 'moov');
    const udta = moov && find(boxes(moov.start, moov.end), 'udta');
    const meta = udta && find(boxes(udta.start, udta.end), 'meta');
    const ilst = meta && find(boxes(meta.start + 4, meta.end), 'ilst'); // meta has 4 bytes of version/flags
    if (!ilst) return {};
    const names = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', covr: 'cover' };
    const tags = {};
    for (const item of boxes(ilst.start, ilst.end)) {
      const key = names[item.type];
      const data = key && find(boxes(item.start, item.end), 'data');
      if (!data || data.end - data.start < 8) continue;
      const kind = u24(b, data.start + 1), payload = b.subarray(data.start + 8, data.end);
      if (key === 'cover') {
        if (payload.length) tags.cover = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: payload.slice() };
      } else {
        const value = clean(utf8.decode(payload));
        if (value) tags[key] = value;
      }
    }
    return tags;
  }

  /** { title, artist, album, cover: { mime, data } }, with whatever the file has (possibly nothing). */
  function read(buffer) {
    const b = new Uint8Array(buffer);
    try {
      return readId3(b) || readMp4(b) || {};
    } catch (_) {
      return {}; // malformed tags: convert without them
    }
  }

  const fitsLatin1 = (s) => [...s].every((c) => c.charCodeAt(0) < 256);

  /** An ID3v2.3 tag for the start of an MP3. */
  function id3(tags) {
    const frames = [];
    const frame = (id, body) => {
      const head = new Uint8Array(10);
      head.set([...id].map((c) => c.charCodeAt(0)));
      new DataView(head.buffer).setUint32(4, body.length);
      frames.push(head, body);
    };
    const encode = (s) => { // ISO-8859-1 when possible, else UTF-16 with a byte-order mark
      if (fitsLatin1(s)) return [0, Uint8Array.from([...s], (c) => c.charCodeAt(0))];
      const u = new Uint8Array(2 + s.length * 2);
      u[0] = 0xff; u[1] = 0xfe;
      for (let i = 0; i < s.length; i++) { u[2 + 2 * i] = s.charCodeAt(i) & 0xff; u[3 + 2 * i] = s.charCodeAt(i) >> 8; }
      return [1, u];
    };
    for (const [id, key] of [['TIT2', 'title'], ['TPE1', 'artist'], ['TALB', 'album']]) {
      if (!tags[key]) continue;
      const [enc, bytes] = encode(tags[key]);
      frame(id, Uint8Array.of(enc, ...bytes));
    }
    if (tags.cover) {
      const mime = Uint8Array.from([...tags.cover.mime], (c) => c.charCodeAt(0));
      const body = new Uint8Array(1 + mime.length + 1 + 1 + 1 + tags.cover.data.length);
      // encoding 0, MIME, terminator, picture type 3 (front cover), empty description
      body.set(mime, 1);
      body[mime.length + 2] = 3;
      body.set(tags.cover.data, mime.length + 4);
      frame('APIC', body);
    }
    const size = frames.reduce((n, f) => n + f.length, 0);
    const out = new Uint8Array(10 + size);
    out.set([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    let o = 10;
    for (const f of frames) { out.set(f, o); o += f.length; }
    return out;
  }

  /** A RIFF "LIST/INFO" chunk with title, artist and album, to append to a WAV. */
  function wavInfo(tags) {
    const enc = new TextEncoder();
    const parts = [];
    for (const [id, key] of [['INAM', 'title'], ['IART', 'artist'], ['IPRD', 'album']]) {
      if (!tags[key]) continue;
      const value = enc.encode(tags[key] + '\0');
      const chunk = new Uint8Array(8 + value.length + (value.length & 1)); // chunks are padded to even sizes
      chunk.set([...id].map((c) => c.charCodeAt(0)));
      new DataView(chunk.buffer).setUint32(4, value.length, true);
      chunk.set(value, 8);
      parts.push(chunk);
    }
    if (!parts.length) return new Uint8Array(0);
    const size = 4 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(8 + size);
    out.set([0x4c, 0x49, 0x53, 0x54]); // "LIST"
    new DataView(out.buffer).setUint32(4, size, true);
    out.set([0x49, 0x4e, 0x46, 0x4f], 8); // "INFO"
    let o = 12;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  return { read, id3, wavInfo };
})();
