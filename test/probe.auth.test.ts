import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { authHeaders, check, loadInput, validateConfig } from "../src/index.js";
import { root } from "./helpers.js";

const exec = promisify(execFile);
const TOKEN = "mrt_live_4f3e2d1c0b9a8f7e6d5c4b3a"; // gitleaks:allow (fake token the tests prove never leaks)
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: { url: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function spec(server: string, schemes: Record<string, unknown> = { bearer: { type: "http", scheme: "bearer" } }) {
  const name = Object.keys(schemes)[0]!;
  return {
    openapi: "3.1.0",
    info: { title: "Auth probe", version: "1" },
    servers: [{ url: server }],
    security: [{ [name]: [] }],
    components: { securitySchemes: schemes },
    paths: {
      "/health": { get: { operationId: "getHealth", summary: "Health", security: [], responses: { "200": { description: "ok" } } } },
      "/me": { get: { operationId: "getProfile", summary: "Current user", responses: { "200": { description: "ok" }, "401": { description: "no token" } } } },
    },
  };
}

function writeSpec(doc: object): string {
  const file = join(mkdtempSync(join(tmpdir(), "muse-ready-auth-")), "openapi.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

const cli = join(root, "dist/cli/index.js");
async function runCli(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec("node", [cli, ...args], { cwd: root, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return { code: err.code as number, stdout: err.stdout as string, stderr: err.stderr as string };
  }
}

describe("authenticated probing", () => {
  beforeAll(async () => {
    await exec("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root });
  }, 120_000);

  it("reads the token only from MUSE_READY_TOKEN and attaches it only to secured operations", async () => {
    const api = await serve((req, res) => res.end(req.headers.authorization ? '{"id":1}' : "{}"));
    const file = writeSpec(spec(api.base));
    const { code, stderr } = await runCli([file, "--probe-allow-private", "--no-color"], { MUSE_READY_TOKEN: TOKEN });
    expect(code).toBeLessThan(2);
    expect(stderr).toContain("authenticated with MUSE_READY_TOKEN");
    const me = api.seen.filter((r) => r.url === "/me");
    expect(me.some((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(me.some((r) => r.headers.authorization === undefined)).toBe(true); // the unauthenticated ERR002 check
    expect(api.seen.filter((r) => r.url === "/health").every((r) => r.headers.authorization === undefined)).toBe(true);
  });

  it("offers no way to pass the token as an argument or in the config file", async () => {
    const { code, stderr } = await runCli(["x.yaml", "--token", TOKEN]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown option/);
    expect(() => validateConfig({ token: TOKEN }, "cfg")).toThrow(/MUSE_READY_TOKEN/);
    expect(() => validateConfig({ probe: { token: TOKEN } }, "cfg")).toThrow(/MUSE_READY_TOKEN/);
  });

  it("uses the spec's API-key header, or the configured header", async () => {
    const input = await loadInput(writeSpec(spec("https://api.example.com", { key: { type: "apiKey", in: "header", name: "X-API-Key" } })));
    expect(authHeaders(TOKEN, input)).toEqual({ "X-API-Key": TOKEN });
    expect(authHeaders(TOKEN, input, "X-Other-Key")).toEqual({ "X-Other-Key": TOKEN });
    expect(authHeaders(TOKEN, input, "Authorization")).toEqual({ Authorization: `Bearer ${TOKEN}` });
    const basic = await loadInput(writeSpec(spec("https://api.example.com", { basic: { type: "http", scheme: "basic" } })));
    expect(authHeaders("user:pass", basic)).toEqual({ Authorization: `Basic ${Buffer.from("user:pass").toString("base64")}` });
  });

  it("sends the token only to the target origin, never to the spec host or across redirects", async () => {
    const elsewhere = await serve((_, res) => res.end("{}"));
    const target = await serve((req, res) => {
      if (req.url === "/me") res.writeHead(302, { location: `${elsewhere.base}/me` }).end();
      else res.end("{}");
    });
    const specHost = await serve((_, res) => res.end(JSON.stringify(spec(target.base, { key: { type: "apiKey", in: "header", name: "X-API-Key" } }))));
    await check(`${specHost.base}/openapi.json`, {
      config: {},
      probe: {
        authHeaders: { "X-API-Key": TOKEN },
        request: { allowInsecureHttp: true, addressPolicy: (ip) => ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" },
      },
    });
    expect(specHost.seen.every((r) => r.headers["x-api-key"] === undefined)).toBe(true);
    expect(target.seen.some((r) => r.headers["x-api-key"] === TOKEN)).toBe(true);
    expect(elsewhere.seen.length).toBeGreaterThan(0);
    expect(elsewhere.seen.every((r) => r.headers["x-api-key"] === undefined)).toBe(true);
  });
});
