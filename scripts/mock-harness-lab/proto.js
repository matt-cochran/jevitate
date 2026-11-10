// BROWSER CODE (also imported by the Node lab): a minimal protobuf + gRPC-Web codec for the
// synthetic triage service. Only what the lab's messages use: string (wire 2), varint (wire 0),
// nested message (wire 2) and repeated nested message. No dependencies.

export const SCHEMAS = {
  Cluster: { 1: ["id", "string"], 2: ["title", "string"], 3: ["reports", "varint"], 4: ["issueNumber", "varint"], 5: ["issueUrl", "string"], 6: ["reporterEmail", "string"], 7: ["updatedAt", "string"] },
  ListClustersRequest: {},
  ListClustersResponse: { 1: ["clusters", "Cluster[]"] },
  GetClusterRequest: { 1: ["id", "string"] },
  GetClusterResponse: { 1: ["cluster", "Cluster"] },
  FileIssueRequest: { 1: ["clusterId", "string"], 2: ["title", "string"], 3: ["severity", "string"] },
  FileIssueResponse: { 1: ["issueNumber", "varint"], 2: ["issueUrl", "string"] },
};

const te = new TextEncoder();
const td = new TextDecoder();

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function concat(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function encode(type, obj) {
  const schema = SCHEMAS[type];
  const parts = [];
  for (const [no, [name, kind]] of Object.entries(schema)) {
    const v = obj?.[name];
    if (v === undefined || v === null || v === "" || v === 0) continue;
    const field = Number(no);
    if (kind === "varint") parts.push(Uint8Array.from([...varint(field << 3), ...varint(v)]));
    else if (kind === "string") {
      const b = te.encode(v);
      parts.push(Uint8Array.from([...varint((field << 3) | 2), ...varint(b.length)]), b);
    } else {
      const sub = kind.endsWith("[]") ? kind.slice(0, -2) : kind;
      for (const item of kind.endsWith("[]") ? v : [v]) {
        const b = encode(sub, item);
        parts.push(Uint8Array.from([...varint((field << 3) | 2), ...varint(b.length)]), b);
      }
    }
  }
  return concat(parts);
}

export function decode(type, bytes) {
  const schema = SCHEMAS[type];
  const out = {};
  let i = 0;
  const readVarint = () => {
    let shift = 0;
    let v = 0;
    for (;;) {
      const b = bytes[i++];
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
    }
  };
  while (i < bytes.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    const def = schema[field];
    if (wire === 0) {
      const v = readVarint();
      if (def) out[def[0]] = v;
    } else if (wire === 2) {
      const len = readVarint();
      const slice = bytes.subarray(i, i + len);
      i += len;
      if (!def) continue;
      const [name, kind] = def;
      if (kind === "string") out[name] = td.decode(slice);
      else if (kind.endsWith("[]")) (out[name] ??= []).push(decode(kind.slice(0, -2), slice));
      else out[name] = decode(kind, slice);
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  for (const [name, kind] of Object.values(schema)) if (kind.endsWith("[]")) out[name] ??= [];
  return out;
}

/** One gRPC-Web frame: flag byte, 4-byte big-endian length, payload. */
export function frame(flag, payload) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

/** A unary gRPC-Web response body: a data frame (unless status != 0) and a trailer frame. */
export function responseBody(message, status = 0, statusMessage = "") {
  const trailer = te.encode(`grpc-status:${status}\r\ngrpc-message:${encodeURIComponent(statusMessage)}\r\n`);
  return status === 0 ? concat([frame(0, message), frame(0x80, trailer)]) : frame(0x80, trailer);
}

/** Splits a gRPC-Web body into its data payload and trailers. */
export function parseBody(bytes) {
  let i = 0;
  let data = new Uint8Array(0);
  const trailers = {};
  while (i + 5 <= bytes.length) {
    const flag = bytes[i];
    const len = new DataView(bytes.buffer, bytes.byteOffset + i + 1, 4).getUint32(0);
    const payload = bytes.subarray(i + 5, i + 5 + len);
    i += 5 + len;
    if (flag & 0x80) {
      for (const line of td.decode(payload).split("\r\n")) {
        const at = line.indexOf(":");
        if (at > 0) trailers[line.slice(0, at).trim()] = decodeURIComponent(line.slice(at + 1).trim());
      }
    } else data = payload;
  }
  return { data, status: Number(trailers["grpc-status"] ?? 2), message: trailers["grpc-message"] ?? "" };
}
