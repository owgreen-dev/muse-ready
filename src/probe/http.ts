import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { TOOL_VERSION } from "../core/version.js";
import { isBlockedAddress } from "./address.js";

export type SafeMethod = "GET" | "HEAD" | "OPTIONS";
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Header names treated as credentials: dropped whenever a redirect changes origin, never echoed anywhere. */
export const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-auth-token"];

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Total time for the request including redirects. Default 10 s. */
  timeoutMs?: number;
  /** Body bytes kept before the response is cut off. Default 1 MiB. */
  maxBytes?: number;
  /** Default 3. */
  maxRedirects?: number;
  /** Allow loopback and private addresses. Off by default; for local development and tests only. */
  allowPrivateNetwork?: boolean;
  /** Allow plain http:// URLs. Off by default. */
  allowInsecureHttp?: boolean;
  /** Extra header names to treat as credentials, e.g. a custom API-key header. */
  credentialHeaders?: string[];
  /** Replaces DNS resolution. Tests use it to simulate DNS rebinding. */
  resolver?: Resolver;
  /** Replaces the address policy. Tests use it to allow exactly one local address. */
  addressPolicy?: (address: string) => boolean;
  /** Extra CA certificates for TLS verification (tests). Verification itself can never be turned off. */
  ca?: string | Buffer;
  /** Also return the raw bytes (for images). */
  binary?: boolean;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  bytes: number;
  truncated: boolean;
  ms: number;
  redirects: string[];
  remoteAddress?: string;
  /** Raw body bytes, only when options.binary is set. */
  buffer?: Buffer;
}

export type ProbeErrorCode =
  | "blocked-method"
  | "blocked-address"
  | "blocked-scheme"
  | "invalid-url"
  | "timeout"
  | "too-many-redirects"
  | "network";

export class ProbeError extends Error {
  constructor(
    readonly code: ProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

/** URL safe to print: no userinfo, query values replaced. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, "…");
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}

const defaultResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export async function safeRequest(url: string, options: SafeRequestOptions = {}): Promise<SafeResponse> {
  const method = (options.method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    throw new ProbeError("blocked-method", `Refusing ${method}: the probe only sends GET, HEAD and OPTIONS.`);
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const policy = options.addressPolicy ?? ((ip: string) => options.allowPrivateNetwork === true || !isBlockedAddress(ip));
  const resolver = options.resolver ?? defaultResolver;
  const credentialNames = new Set([...CREDENTIAL_HEADERS, ...(options.credentialHeaders ?? []).map((h) => h.toLowerCase())]);

  const started = Date.now();
  const deadline = started + timeoutMs;
  const redirects: string[] = [];
  let headers: Record<string, string> = {
    "user-agent": `muse-ready/${TOOL_VERSION}`,
    accept: "application/json, */*;q=0.5",
    ...lowerKeys(options.headers ?? {}),
  };
  let current = parseUrl(url, options);
  let currentMethod = method;

  for (;;) {
    const res = await once(current, currentMethod, headers, { deadline, maxBytes, policy, resolver, ca: options.ca, binary: options.binary });
    const location = res.headers.location;
    if (!REDIRECT_STATUSES.has(res.status) || typeof location !== "string") {
      return { ...res, url: redactUrl(current.toString()), redirects, ms: Date.now() - started };
    }
    if (redirects.length >= maxRedirects) {
      throw new ProbeError("too-many-redirects", `Stopped after ${maxRedirects} redirects at ${redactUrl(current.toString())}.`);
    }
    const next = parseUrl(new URL(location, current).toString(), options);
    if (next.origin !== current.origin) {
      // Never carry credentials to another origin.
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !credentialNames.has(k)));
    }
    if (res.status === 303) currentMethod = "GET";
    redirects.push(redactUrl(next.toString()));
    current = next;
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

function parseUrl(raw: string, options: SafeRequestOptions): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProbeError("invalid-url", "Not a valid absolute URL.");
  }
  if (u.username || u.password) throw new ProbeError("invalid-url", "URLs with embedded credentials are refused.");
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && options.allowInsecureHttp) return u;
  throw new ProbeError("blocked-scheme", `Refusing ${u.protocol} URL ${redactUrl(raw)}: the probe only uses HTTPS.`);
}

interface OnceOptions {
  deadline: number;
  maxBytes: number;
  policy: (address: string) => boolean;
  resolver: Resolver;
  ca?: string | Buffer;
  binary?: boolean;
}

async function once(
  url: URL,
  method: string,
  headers: Record<string, string>,
  o: OnceOptions,
): Promise<Omit<SafeResponse, "url" | "redirects" | "ms">> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const shown = redactUrl(url.toString());

  // Resolve and vet every address before connecting. IP literals skip Node's lookup, so check them here too.
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await withDeadline(o.resolver(host), o.deadline, shown);
    } catch (err) {
      if (err instanceof ProbeError) throw err;
      throw new ProbeError("network", `Could not resolve ${url.hostname}.`);
    }
  }
  if (addresses.length === 0) throw new ProbeError("network", `Could not resolve ${url.hostname}.`);
  const blocked = addresses.filter((a) => !o.policy(a.address));
  if (blocked.length) {
    throw new ProbeError("blocked-address", `Refusing ${shown}: it resolves to a private, loopback or reserved address (${blocked[0]!.address}).`);
  }

  // Pin the connection to the vetted addresses so a second DNS answer cannot redirect it.
  const lookup: LookupFunction = (_hostname, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
    else cb(null, addresses[0]!.address, addresses[0]!.family);
  };

  const remaining = o.deadline - Date.now();
  if (remaining <= 0) throw new ProbeError("timeout", `Timed out before connecting to ${shown}.`);

  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions & { ca?: string | Buffer; rejectUnauthorized?: boolean } = {
      method,
      headers,
      lookup,
      agent: false,
      ...(url.protocol === "https:" ? { ca: o.ca, rejectUnauthorized: true, servername: isIP(host) ? undefined : host } : {}),
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const finish = () => {
        clearTimeout(timer);
        const all = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: o.binary ? "" : all.toString("utf8"),
          ...(o.binary ? { buffer: all } : {}),
          bytes,
          truncated,
          remoteAddress: req.socket?.remoteAddress,
        });
      };
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = o.maxBytes - bytes;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          bytes += room;
          truncated = true;
          res.destroy();
          finish();
          return;
        }
        chunks.push(chunk);
        bytes += chunk.length;
      });
      res.on("end", () => !truncated && finish());
      res.on("error", (err) => !truncated && fail(err));
    });
    const fail = (err: Error) => {
      clearTimeout(timer);
      if (err instanceof ProbeError) reject(err);
      else reject(new ProbeError("network", `Request to ${shown} failed: ${describeNetworkError(err)}.`));
    };
    const timer = setTimeout(() => {
      req.destroy(new ProbeError("timeout", `Timed out after ${Math.round((Date.now() - (o.deadline - remaining)) / 1000)} s waiting for ${shown}.`));
    }, remaining);
    req.on("socket", (socket) => {
      socket.on("connect", () => {
        // Defence in depth: check the address we actually connected to.
        const remote = socket.remoteAddress;
        if (remote && !o.policy(remote)) req.destroy(new ProbeError("blocked-address", `Refusing ${shown}: connected to a blocked address.`));
      });
    });
    req.on("error", fail);
    req.end();
  });
}

function withDeadline<T>(p: Promise<T>, deadline: number, shown: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new ProbeError("timeout", `Timed out resolving ${shown}.`)), Math.max(0, deadline - Date.now()));
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Error text without anything request-specific (never headers). */
function describeNetworkError(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ECONNRESET") return "connection reset";
  if (code === "ENOTFOUND") return "host not found";
  if (code && /^(CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL)/.test(code)) return `TLS verification failed (${code})`;
  return code ?? "network error";
}
