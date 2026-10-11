import { inflateSync } from "node:zlib";

/**
 * #471 — a minimal PNG decoder for the jz-mask-v1 pixel proof (demo-capture.ts): 8-bit RGB or RGBA,
 * not interlaced — what Chromium's screenshots are. Anything else throws, so a capture that cannot
 * be read is never taken as proven.
 */

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel (alpha 255 for an RGB image). */
  readonly rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 64 megapixels: far above any viewport capture; refuses a decompression bomb. */
const MAX_PIXELS = 64 * 1024 * 1024;

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  let ended = false;
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (data.length !== len) throw new Error("truncated PNG");
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      const interlace = data[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${color}, interlace ${interlace})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") {
      ended = true;
      break;
    }
    at += 12 + len;
  }
  if (!ended || channels === 0 || width === 0 || height === 0) throw new Error("incomplete PNG");
  if (width * height > MAX_PIXELS) throw new Error("PNG too large");
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error("PNG data has the wrong size");
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? px[row + x - channels]! : 0;
      const b = y > 0 ? px[prev + x]! : 0;
      const c = x >= channels && y > 0 ? px[prev + x - channels]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = v;
          break;
        case 1:
          out = v + a;
          break;
        case 2:
          out = v + b;
          break;
        case 3:
          out = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      px[row + x] = out & 255;
    }
  }
  if (channels === 4) return { width, height, rgba: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i]!;
    rgba[j + 1] = px[i + 1]!;
    rgba[j + 2] = px[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}
