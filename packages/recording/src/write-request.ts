/**
 * Is a request a WRITE (it may change server state) or a READ? (#110)
 *
 * The HTTP method alone is not enough: gRPC-web, Connect and Twirp send every RPC as a POST,
 * including pure reads (`/pkg.DecisionService/GetDecisionDetail`, `ListDecisions`…). Treating those
 * as writes made the repeated-side-effect guard (#92) refuse to re-open a card whose render fired
 * read RPCs, and made the duplicate-write usability signal (#96) report React re-render
 * double-fetches as major duplicate side effects.
 *
 * Rules (independent code, no model):
 *  - GET / HEAD / OPTIONS (and any method that is not POST/PUT/PATCH/DELETE) is a read;
 *  - an RPC-over-POST — a `/<pkg>.<Service>/<Method>` path, sent as gRPC-web, Connect, protobuf or
 *    JSON (or with no content type known) — is a read when its method name starts with a read verb
 *    (`Get`, `List`, `Search`, `Find`, `Watch`, `Stream`, `Count`, `Describe`, `Read`, `Query`,
 *    `Fetch`, `Lookup`, `BatchGet`);
 *  - an operator-supplied read pattern (`--read-rpc`, target config `safety.readRequests`) marks
 *    more requests as reads: a pattern starting with "/" is a path glob (`/api/search*`), any other
 *    pattern a glob over the RPC method (`Get*`, `*Preview`, `pkg.Service/Estimate*`);
 *  - everything else sent with POST/PUT/PATCH/DELETE is a write.
 * A misclassified read only costs a guard/finding; a misclassified write would let the run repeat a
 * side effect — so an unknown request is a write.
 */

/** The request methods that may change server state. */
export const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** RPC method names that read (the method must continue with an upper-case letter, a digit or end). */
export const READ_RPC_VERB = /^(?:Get|List|Search|Find|Watch|Stream|Count|Describe|Read|Query|Fetch|Lookup|Batch(?:Get|Read))(?=[A-Z0-9_]|$)/;

/** Content types an RPC-over-POST is sent with. */
const RPC_CONTENT_TYPE = /^\s*application\/(?:grpc(?:-web)?(?:[+;]|\s*$)|grpc-web-text|connect\+|proto(?:buf)?\b|x-protobuf|json\b)/i;

/** `/<pkg>.<Service>/<Method>` (optionally under a prefix such as `/twirp/` or `/api/`). */
const RPC_PATH = /\/([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\/([A-Za-z_][\w]*)\/?$/;

export interface RequestShape {
  readonly method: string;
  /** The request path (or a full URL — only its path is used). */
  readonly path: string;
  /** The REQUEST's content type, when known. */
  readonly contentType?: string | null;
}

export interface WriteClassifierOptions {
  /** Extra read patterns (see the module doc). */
  readonly readRequests?: readonly string[];
}

export type WriteClassifier = (req: RequestShape) => boolean;

/** The `{ service, method }` of an RPC-shaped path, or null. */
export function rpcMethodOf(path: string): { readonly service: string; readonly method: string } | null {
  const m = RPC_PATH.exec(pathOnly(path));
  return m === null ? null : { service: m[1]!, method: m[2]! };
}

function pathOnly(pathOrUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathOrUrl)) {
    try {
      return new URL(pathOrUrl).pathname;
    } catch {
      /* fall through */
    }
  }
  return pathOrUrl.split(/[?#]/)[0] ?? pathOrUrl;
}

function globToRegExp(glob: string): RegExp {
  const src = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${src}$`, "i");
}

/** Builds a classifier: `true` ⇔ the request is a write. Patterns are compiled once. */
export function writeClassifier(opts: WriteClassifierOptions = {}): WriteClassifier {
  const patterns = (opts.readRequests ?? []).map((p) => p.trim()).filter((p) => p !== "");
  const pathGlobs = patterns.filter((p) => p.startsWith("/")).map(globToRegExp);
  const rpcGlobs = patterns.filter((p) => !p.startsWith("/")).map(globToRegExp);
  return (req) => {
    if (!WRITE_METHODS.has(req.method.toUpperCase())) return false;
    const path = pathOnly(req.path);
    if (pathGlobs.some((g) => g.test(path))) return false;
    const rpc = rpcMethodOf(path);
    if (rpc === null) return true;
    const ct = req.contentType ?? null;
    // A body type that is not an RPC encoding (a form post) is not an RPC call.
    if (ct !== null && ct !== "" && !RPC_CONTENT_TYPE.test(ct)) return true;
    if (READ_RPC_VERB.test(rpc.method)) return false;
    const short = rpc.service.split(".").pop() ?? rpc.service;
    const names = [rpc.method, `${rpc.service}/${rpc.method}`, `${short}/${rpc.method}`];
    return !rpcGlobs.some((g) => names.some((n) => g.test(n)));
  };
}

/** One-off form of `writeClassifier(opts)(req)`. */
export function isWriteRequest(req: RequestShape, opts: WriteClassifierOptions = {}): boolean {
  return writeClassifier(opts)(req);
}
