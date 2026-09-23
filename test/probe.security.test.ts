// Security tests for the probe's HTTP client. security/policy.json requires every titled test below, verbatim.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { expandV6, isBlockedAddress } from "../src/probe/address.js";
import { ProbeError, safeRequest, type SafeRequestOptions } from "../src/probe/http.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface TestServer {
  url: string;
  origin: string;
  requests: { method: string; url: string; headers: IncomingMessage["headers"] }[];
}
const servers: Server[] = [];

async function serve(handler: Handler): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${origin}/`, origin, requests };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

// Local tests must explicitly allow plain HTTP and exactly the loopback address the test server uses.
const local: SafeRequestOptions = { allowInsecureHttp: true, addressPolicy: (ip) => ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" };

async function probeError(p: Promise<unknown>): Promise<ProbeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProbeError);
    return err as ProbeError;
  }
  throw new Error("expected the request to be refused");
}

const TOKEN = "sk-live-muse-ready-TEST-TOKEN-9f8e7d6c5b4a";

describe("probe HTTP client security", () => {
  it("refuses hosts that resolve to private or loopback addresses", async () => {
    const s = await serve((_, res) => res.end("secret internal data"));
    // Default policy: loopback is refused even over allowed plain HTTP, and nothing reaches the server.
    expect((await probeError(safeRequest(s.url, { allowInsecureHttp: true }))).code).toBe("blocked-address");
    expect((await probeError(safeRequest(s.url.replace("127.0.0.1", "localhost"), { allowInsecureHttp: true }))).code).toBe("blocked-address");
    // DNS rebinding: a public-looking name that resolves to a private address.
    const rebinding = { allowInsecureHttp: true, resolver: async () => [{ address: "10.0.0.5", family: 4 }] };
    expect((await probeError(safeRequest("http://api.example.test/", rebinding))).code).toBe("blocked-address");
    // Mixed answers are refused if any address is private.
    const mixed = { resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] };
    expect((await probeError(safeRequest("https://api.example.test/", mixed))).code).toBe("blocked-address");
    // Cloud metadata and IPv6 forms.
    for (const target of ["https://169.254.169.254/latest/meta-data/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[fd00::1]/", "https://0.0.0.0/"]) {
      expect((await probeError(safeRequest(target))).code, target).toBe("blocked-address");
    }
    expect(s.requests).toHaveLength(0);
  });

  it("re-checks the address on every redirect", async () => {
    const s = await serve((req, res) => {
      if (req.url === "/metadata") res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      else if (req.url === "/rebind") res.writeHead(302, { location: "http://internal.example.test/" }).end();
      else if (req.url === "/loop") res.writeHead(302, { location: "/loop" }).end();
      else res.end("ok");
    });
    expect((await probeError(safeRequest(`${s.origin}/metadata`, local))).code).toBe("blocked-address");
    const resolver = async (host: string) => [{ address: host === "internal.example.test" ? "192.168.1.10" : "127.0.0.1", family: 4 }];
    expect((await probeError(safeRequest(`${s.origin}/rebind`, { ...local, resolver }))).code).toBe("blocked-address");
    expect((await probeError(safeRequest(`${s.origin}/loop`, local))).code).toBe("too-many-redirects");
    expect(s.requests.filter((r) => r.url === "/loop")).toHaveLength(4); // first request plus 3 redirects
    // An https -> http downgrade on redirect is refused without allowInsecureHttp.
    const t = await serve((_, res) => res.writeHead(302, { location: "http://example.com/" }).end());
    expect((await probeError(safeRequest(t.url, { addressPolicy: local.addressPolicy, allowInsecureHttp: false }).catch((e) => Promise.reject(e)))).code).toBe("blocked-scheme");
  });

  it("never sends a method other than GET, HEAD or OPTIONS", async () => {
    const s = await serve((_, res) => res.end("ok"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "CONNECT", "TRACE"]) {
      expect((await probeError(safeRequest(s.url, { ...local, method }))).code, method).toBe("blocked-method");
    }
    expect(s.requests).toHaveLength(0);
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect((await safeRequest(s.url, { ...local, method })).status).toBe(200);
    expect(s.requests.map((r) => r.method)).toEqual(["GET", "HEAD", "OPTIONS"]);
  });

  it("aborts responses larger than the size limit", async () => {
    const s = await serve((_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, "a");
      let sent = 0;
      const pump = () => {
        while (sent < 5 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    const started = Date.now();
    const r = await safeRequest(s.url, { ...local, maxBytes: 100_000 });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(100_000);
    expect(r.body.length).toBe(100_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    const small = await safeRequest(s.url.replace(/\/$/, "/"), { ...local, method: "HEAD" });
    expect(small.truncated).toBe(false);
  });

  it("times out slow responses", async () => {
    const s = await serve((req, res) => {
      if (req.url === "/slow-body") {
        res.writeHead(200);
        res.write("partial");
        setTimeout(() => res.end("rest"), 3_000);
      } else setTimeout(() => res.end("late"), 3_000);
    });
    let started = Date.now();
    expect((await probeError(safeRequest(s.url, { ...local, timeoutMs: 200 }))).code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_500);
    started = Date.now();
    const err = await probeError(safeRequest(`${s.origin}/slow-body`, { ...local, timeoutMs: 200 }));
    expect(["timeout", "network"]).toContain(err.code);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("only sends credentials to the declared server host", async () => {
    const other = await serve((_, res) => res.end("other origin"));
    const target = await serve((_, res) => res.writeHead(307, { location: `${other.origin}/landing` }).end());
    const r = await safeRequest(target.url, {
      ...local,
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Custom-Key": TOKEN, Accept: "application/json" },
      credentialHeaders: ["X-Custom-Key"],
    });
    expect(r.status).toBe(200);
    expect(target.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(target.requests[0]!.headers["x-custom-key"]).toBe(TOKEN);
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]!.headers.authorization).toBeUndefined();
    expect(other.requests[0]!.headers["x-custom-key"]).toBeUndefined();
    expect(other.requests[0]!.headers.accept).toBe("application/json"); // non-credential headers survive
    // A same-origin redirect keeps credentials.
    const same = await serve((req, res) => (req.url === "/" ? res.writeHead(302, { location: "/next" }).end() : res.end("ok")));
    await safeRequest(same.url, { ...local, headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(same.requests[1]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("never writes credentials into any report format", async () => {
    // At this layer the "reports" are results and errors. T-004 extends this to the report renderers.
    const s = await serve((req, res) => {
      if (req.url?.startsWith("/echo")) res.end("fine");
      else if (req.url === "/slow") setTimeout(() => res.end(), 2_000);
      else res.writeHead(302, { location: `http://127.0.0.1:1/?token=${TOKEN}` }).end();
    });
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const outputs: string[] = [];
    outputs.push(JSON.stringify(await safeRequest(`${s.origin}/echo?api_key=${TOKEN}`, { ...local, headers })));
    for (const url of [`${s.origin}/slow`, `${s.origin}/redirect`, `https://user:${TOKEN}@example.com/`, `ftp://example.com/?k=${TOKEN}`]) {
      const err = await probeError(safeRequest(url, { ...local, headers, timeoutMs: 300 }));
      outputs.push(err.message, String(err.stack), JSON.stringify(err));
    }
    for (const out of outputs) expect(out).not.toContain(TOKEN);
  });
});

describe("address policy", () => {
  it("blocks every non-public range and allows public addresses", () => {
    const blocked = [
      "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254",
      "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
      "::", "::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1",
      "2001:db8::1", "2002:0a00:0001::1", "not-an-ip",
    ];
    const allowed = ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
    for (const ip of blocked) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of allowed) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it("expands IPv6 forms", () => {
    expect(expandV6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandV6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(expandV6("2606:4700::1111")).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111]);
  });
});
