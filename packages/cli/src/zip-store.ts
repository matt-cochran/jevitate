/**
 * #471 — a minimal, deterministic ZIP writer for the Journeeze catalog bundle upload (journeeze-saas
 * `docs/contract/catalog-bundle-upload-v1.md` §4.2: `application/zip`, `bundle.json` at the root
 * and the media under `media/`). Entries are STORED (media is already compressed), in the given
 * order, with a fixed timestamp (1980-01-01 00:00) and no extra fields, so the same bundle always
 * gives the same bytes — a re-publish reuses its Idempotency-Key with the same body digest. No
 * ZIP64: refused past 4 GiB or 65,535 entries (far above the contract's 256 MiB upload).
 */

export interface ZipEntry {
  /** A relative path with `/` separators: no leading `/`, no `..`, no `\`. */
  readonly name: string;
  readonly data: Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SAFE_NAME = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,512}$/u;
/** 1980-01-01 00:00:00 in MS-DOS date/time. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zipStore(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error("too many ZIP entries");
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (!SAFE_NAME.test(e.name)) throw new Error(`unsafe ZIP entry name ${JSON.stringify(e.name)}`);
    if (seen.has(e.name)) throw new Error(`duplicate ZIP entry ${e.name}`);
    seen.add(e.name);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const size = e.data.byteLength;
    if (offset + 30 + name.length + size > 0xffffffff) throw new Error("ZIP too large");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength));
    centrals.push(central, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
