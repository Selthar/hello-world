// Minimal ZIP builder for service workers — no dependencies
// Supports STORE compression only (no deflate needed for images/videos which are already compressed)

const ZipBuilder = (() => {
  function u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  }
  function u16(n) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    return b;
  }

  function encodeStr(s) {
    return new TextEncoder().encode(s);
  }

  function concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  // CRC-32 table
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // DOS date/time encoding
  function dosDateTime() {
    const d = new Date();
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { date, time };
  }

  return class ZipBuilder {
    constructor() {
      this._files = []; // { name, data }
    }

    addFile(name, data /* Uint8Array */) {
      this._files.push({ name, data });
    }

    build() {
      const localHeaders = [];
      const centralHeaders = [];
      let offset = 0;

      for (const { name, data } of this._files) {
        const nameBytes = encodeStr(name);
        const crc = crc32(data);
        const size = data.length;
        const { date, time } = dosDateTime();

        // Local file header
        const local = concat(
          new Uint8Array([0x50, 0x4B, 0x03, 0x04]), // signature
          u16(20),          // version needed
          u16(0),           // flags
          u16(0),           // compression: STORE
          u16(time),        // mod time
          u16(date),        // mod date
          u32(crc),         // CRC-32
          u32(size),        // compressed size
          u32(size),        // uncompressed size
          u16(nameBytes.length), // filename length
          u16(0),           // extra field length
          nameBytes,
          data
        );

        localHeaders.push({ local, offset, nameBytes, crc, size, date, time });
        offset += local.length;
      }

      // Central directory
      const centralParts = [];
      for (const { offset: loff, nameBytes, crc, size, date, time } of localHeaders) {
        const central = concat(
          new Uint8Array([0x50, 0x4B, 0x01, 0x02]), // signature
          u16(20),          // version made by
          u16(20),          // version needed
          u16(0),           // flags
          u16(0),           // compression: STORE
          u16(time),
          u16(date),
          u32(crc),
          u32(size),
          u32(size),
          u16(nameBytes.length),
          u16(0),           // extra field length
          u16(0),           // comment length
          u16(0),           // disk number start
          u16(0),           // internal attrs
          u32(0),           // external attrs
          u32(loff),        // relative offset of local header
          nameBytes
        );
        centralParts.push(central);
      }

      const centralDir = concat(...centralParts);
      const centralSize = centralDir.length;
      const numFiles = this._files.length;

      // End of central directory record
      const eocd = concat(
        new Uint8Array([0x50, 0x4B, 0x05, 0x06]), // signature
        u16(0),             // disk number
        u16(0),             // disk with central dir
        u16(numFiles),      // entries on this disk
        u16(numFiles),      // total entries
        u32(centralSize),   // central dir size
        u32(offset),        // central dir offset
        u16(0)              // comment length
      );

      const allLocals = concat(...localHeaders.map(h => h.local));
      return concat(allLocals, centralDir, eocd);
    }
  };
})();
