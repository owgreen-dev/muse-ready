import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { check, loadInput, runRules, BUILTIN_RULES, type ProbeOptions, type ProbeResult, type Report } from "../src/index.js";
import { result } from "./helpers.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function serve(handler: Handler, tls?: { key: string; cert: string }) {
  const requests: { method: string; url: string; auth?: string }[] = [];
  const wrapped: Handler = (req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    handler(req, res);
  };
  const server = tls ? createHttps(tls, wrapped) : createHttp(wrapped);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { base: `${tls ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const LOCAL: ProbeOptions = { request: { allowInsecureHttp: true, addressPolicy: (ip) => ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" } };

function spec(server: string, extra: Record<string, unknown> = {}) {
  return {
    openapi: "3.1.0",
    info: { title: "Probe target", version: "1" },
    servers: [{ url: `${server}/v1` }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths: {
      "/health": { get: { operationId: "getHealth", summary: "Service health", security: [], responses: { "200": { description: "ok" } } } },
      "/items": {
        get: {
          operationId: "listItems",
          summary: "List items",
          responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { type: "object" } } } } } },
        },
        post: { operationId: "createItem", summary: "Create an item", responses: { "201": { description: "created" } } },
      },
      "/items/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, example: "abc" }],
        get: { operationId: "getItem", summary: "Get an item", responses: { "200": { description: "ok" } } },
        put: { operationId: "replaceItem", summary: "Replace an item", responses: { "200": { description: "ok" } } },
        patch: { operationId: "updateItem", summary: "Update an item", responses: { "200": { description: "ok" } } },
        delete: { operationId: "deleteItem", summary: "Delete an item", responses: { "204": { description: "gone" } } },
      },
      "/logout": { get: { operationId: "logoutUser", summary: "Log the user out", responses: { "200": { description: "ok" } } } },
      "/search": {
        get: {
          operationId: "searchItems",
          summary: "Search",
          parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      ...extra,
    },
  };
}

function writeSpec(doc: object): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-ready-probe-"));
  const file = join(dir, "openapi.yaml");
  writeFileSync(file, stringify(doc));
  return file;
}

/** A well-behaved API: public health, secured routes answer 401 with an explanation. */
const goodApi: Handler = (req, res) => {
  const url = req.url ?? "";
  if (url === "/v1/health") return void res.end('{"ok":true}');
  if (!req.headers.authorization) {
    res.writeHead(401, { "content-type": "application/json" });
    return void res.end('{"error":"Missing bearer token. Create one in Settings → API tokens."}');
  }
  res.end("[]");
};

describe("--probe", () => {
  it("makes no requests unless asked", async () => {
    const s = await serve(goodApi);
    const report = await check(writeSpec(spec(s.base)), { config: {} });
    expect(s.requests).toHaveLength(0);
    expect(report.probe).toBeUndefined();
    for (const id of ["NET002", "LAT001", "ERR002", "PAGE002"]) expect(result(report, id).status).toBe("not-applicable");
  });

  it("sends only read requests during a full probe of an API with write operations", async () => {
    const s = await serve(goodApi);
    const report = await check(writeSpec(spec(s.base)), { config: {}, probe: LOCAL });
    expect(s.requests.length).toBeGreaterThan(0);
    expect(s.requests.filter((r) => !["GET", "HEAD", "OPTIONS"].includes(r.method))).toEqual([]);
    const paths = s.requests.map((r) => r.url);
    expect(paths).toContain("/v1/items/abc"); // path parameter filled from its example
    expect(paths.some((p) => p.startsWith("/v1/search"))).toBe(false); // required query param without example: skipped
    expect(paths).not.toContain("/v1/logout"); // GET named like an action: skipped
    expect(report.probe?.requests.length).toBe(s.requests.length);
  });

  it("records requests in the JSON report without response bodies", async () => {
    const s = await serve(goodApi);
    const report = await check(writeSpec(spec(s.base)), { config: {}, probe: LOCAL });
    const first = report.probe!.requests[0]!;
    expect(first).toMatchObject({ method: "GET", path: expect.stringMatching(/^\/v1\//), status: expect.any(Number), ms: expect.any(Number) });
    expect(JSON.stringify(report)).not.toContain("bodySample");
    expect(JSON.stringify(report)).not.toContain("Missing bearer token");
    expect(report.probe!.skipped).toContainEqual({ operation: "GET /logout", reason: expect.stringContaining("named like an action") });
  });

  it("ERR002 passes when secured operations answer 401 with an explanation", async () => {
    const s = await serve(goodApi);
    const report = await check(writeSpec(spec(s.base)), { config: {}, probe: LOCAL });
    expect(result(report, "ERR002").status).toBe("pass");
  });

  it("ERR002 fails when a secured operation answers without credentials or leaks a stack trace", async () => {
    const open = await serve((_, res) => res.end("[]"));
    expect(result(await check(writeSpec(spec(open.base)), { config: {}, probe: LOCAL }), "ERR002").status).toBe("fail");

    const leaky = await serve((req, res) => {
      if (req.url === "/v1/health") return void res.end("ok");
      res.writeHead(500);
      res.end("TypeError: Cannot read properties of undefined\n    at handler (/srv/app/routes/items.js:42:13)\n");
    });
    const r = result(await check(writeSpec(spec(leaky.base)), { config: {}, probe: LOCAL }), "ERR002");
    expect(r.status).toBe("fail");
    expect(r.findings.map((f) => f.message).join("\n")).toContain("a JavaScript stack trace");
  });

  it("PAGE002 flags oversized list responses", async () => {
    const big = (bytes: number): Handler => (req, res) => {
      if (req.url === "/v1/items") return void res.end(`[${'"x",'.repeat(bytes / 4)}"x"]`);
      res.end("{}");
    };
    const openSpec = (base: string) => ({ ...spec(base), security: [] });
    const medium = await serve(big(300 * 1024));
    expect(result(await check(writeSpec(openSpec(medium.base)), { config: {}, probe: LOCAL }), "PAGE002").status).toBe("warn");
    const huge = await serve(big(2 * 1024 * 1024));
    expect(result(await check(writeSpec(openSpec(huge.base)), { config: {}, probe: LOCAL }), "PAGE002").status).toBe("fail");
    const small = await serve(big(1024));
    expect(result(await check(writeSpec(openSpec(small.base)), { config: {}, probe: LOCAL }), "PAGE002").status).toBe("pass");
  });

  describe("NET002 over TLS", () => {
    let tls: { key: string; cert: string };
    beforeAll(() => {
      const dir = mkdtempSync(join(tmpdir(), "muse-ready-tls-"));
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      ], { stdio: "ignore" });
      tls = { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
    });

    it("passes when the certificate verifies and the address is allowed", async () => {
      const s = await serve(goodApi, tls);
      const report = await check(writeSpec(spec(s.base)), { config: {}, probe: { request: { ...LOCAL.request, allowInsecureHttp: false, ca: tls.cert } } });
      expect(result(report, "NET002").status).toBe("pass");
    });

    it("fails when the certificate does not verify", async () => {
      const s = await serve(goodApi, tls);
      const r = result(await check(writeSpec(spec(s.base)), { config: {}, probe: { request: { ...LOCAL.request, allowInsecureHttp: false } } }), "NET002");
      expect(r.status).toBe("fail");
      expect(r.message).toContain("TLS verification failed");
    });

    it("fails when the host resolves to a private address", async () => {
      const report = await check(writeSpec(spec("https://api.example.test")), {
        config: {},
        probe: { request: { resolver: async () => [{ address: "10.0.0.8", family: 4 }] } },
      });
      expect(result(report, "NET002").status).toBe("fail");
      expect(report.probe!.requests).toHaveLength(0);
    });
  });

  it("probes an MCP server with a single GET", async () => {
    const s = await serve((_, res) => res.end("ok"));
    const dir = mkdtempSync(join(tmpdir(), "muse-ready-mcp-"));
    const file = join(dir, "tools.json");
    writeFileSync(file, JSON.stringify({ tools: [{ name: "ping", description: "Checks the server is up.", inputSchema: { type: "object" } }] }));
    const report = await check(file, { config: { connector: { serverUrl: `${s.base}/mcp` } }, probe: LOCAL });
    expect(s.requests).toEqual([{ method: "GET", url: "/mcp", auth: undefined }]);
    expect(result(report, "LAT001").status).toBe("pass");
  });

  it("reports why it could not probe", async () => {
    const report = await check(writeSpec({ ...spec("x"), servers: undefined }), { config: {}, probe: LOCAL });
    expect(result(report, "LAT001").message).toContain("declares no servers");
  });
});

describe("live rules on synthetic probe results", () => {
  async function judge(probe: Partial<ProbeResult>): Promise<Report> {
    const input = await loadInput(writeSpec(spec("https://api.example.com")));
    return runRules(input, BUILTIN_RULES, {}, { enabled: true, target: "https://api.example.com/v1", requests: [], skipped: [], ...probe });
  }
  const ok = (ms: number) => ({ method: "GET", path: "/v1/health", operation: "GET /health", status: 200, ms, bytes: 2 });

  it("LAT001 passes fast APIs, warns above 3 s and fails on timeouts or above 30 s", async () => {
    expect(result(await judge({ requests: [ok(100), ok(120), ok(90)] }), "LAT001").status).toBe("pass");
    expect(result(await judge({ requests: [ok(100), ok(3500)] }), "LAT001").status).toBe("warn");
    expect(result(await judge({ requests: [ok(31_000)] }), "LAT001").status).toBe("fail");
    const timedOut = { method: "GET", path: "/v1/slow", error: { code: "timeout", message: "Timed out" } };
    expect(result(await judge({ requests: [ok(100), timedOut] }), "LAT001").status).toBe("fail");
  });

  it("ERR002 flags leaked credentials in error bodies", async () => {
    const leak = { method: "GET", path: "/v1/items", operation: "GET /items", status: 401, ms: 5, bodySample: "bad key AKIAABCDEFGHIJKLMNOP" }; // gitleaks:allow (fake key: ERR002 must detect it)
    expect(result(await judge({ requests: [leak] }), "ERR002").status).toBe("fail");
  });

  it("NET002 fails a plain-HTTP target", async () => {
    expect(result(await judge({ dns: { addresses: ["93.184.216.34"], blocked: [] }, requests: [ok(10)] }), "NET002").status).toBe("fail");
  });
});
