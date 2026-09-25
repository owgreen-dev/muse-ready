import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { check, type ProbeOptions } from "../src/index.js";
import { parseJsonRpc } from "../src/probe/mcp.js";
import { result, root } from "./helpers.js";

const exec = promisify(execFile);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

interface Behaviour {
  stateful?: boolean; // tools/list needs an Mcp-Session-Id
  unstable?: boolean; // the tool list changes on every call
  sse?: boolean; // answer as text/event-stream
  paginate?: boolean; // two pages
  requireAuth?: string; // bearer token required
}

async function mcpServer(b: Behaviour = {}) {
  const seen: { method: string; rpc?: string; auth?: string; session?: string }[] = [];
  let calls = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const msg = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method ?? "", rpc: msg?.method, auth: req.headers.authorization, session: req.headers["mcp-session-id"] as string | undefined });
      if (req.method !== "POST") return void res.writeHead(405).end();
      if (b.requireAuth && req.headers.authorization !== `Bearer ${b.requireAuth}`) return void res.writeHead(401).end();
      const reply = (result: unknown, headers: Record<string, string> = {}) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
        if (b.sse) res.writeHead(200, { "content-type": "text/event-stream", ...headers }).end(`event: message\ndata: ${body}\n\n`);
        else res.writeHead(200, { "content-type": "application/json", ...headers }).end(body);
      };
      if (msg.method === "initialize") return reply({ protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "fake" } }, b.stateful ? { "mcp-session-id": "s-1" } : {});
      if (msg.method === "notifications/initialized") return void res.writeHead(202).end();
      if (msg.method === "tools/list") {
        if (b.stateful && req.headers["mcp-session-id"] !== "s-1") return void res.writeHead(400).end("Bad Request: no session");
        calls++;
        const tools = [{ name: "search", description: "Search notes", inputSchema: { type: "object" } }];
        if (b.unstable && calls % 2 === 0) tools.push({ name: "beta_feature", description: "Sometimes here", inputSchema: { type: "object" } });
        if (b.paginate && !msg.params?.cursor) return reply({ tools, nextCursor: "page2" });
        if (b.paginate) return reply({ tools: [{ name: "export", description: "Export notes", inputSchema: { type: "object" } }] });
        return reply({ tools });
      }
      res.writeHead(400).end();
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

const LOCAL: ProbeOptions = { mcp: true, request: { allowInsecureHttp: true, addressPolicy: (ip) => ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" } };

function toolsFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "muse-ready-mcpprobe-")), "tools.json");
  writeFileSync(file, JSON.stringify({ tools: [{ name: "search", title: "Search", description: "Search the user's notes by keyword.", inputSchema: { type: "object" } }] }));
  return file;
}

async function run(serverUrl: string, probe: ProbeOptions = LOCAL) {
  const report = await check(toolsFile(), { config: { profile: "mcp", connector: { serverUrl, auth: "bearer" } }, probe });
  return { report, stable: result(report, "MCP004"), stateless: result(report, "MCP005") };
}

describe("--probe-mcp", () => {
  it("passes a stateless server with a stable tool list", async () => {
    const s = await mcpServer();
    const { stable, stateless } = await run(s.url);
    expect([stable.status, stateless.status]).toEqual(["pass", "pass"]);
    expect(s.seen.filter((r) => r.method === "POST").map((r) => r.rpc)).toEqual(["tools/list", "initialize", "notifications/initialized", "tools/list", "tools/list"]);
  });

  it("warns when tools/list needs a session, and still checks stability in the session", async () => {
    const s = await mcpServer({ stateful: true });
    const { stable, stateless } = await run(s.url);
    expect(stable.status).toBe("pass");
    expect(stateless.status).toBe("warn");
    expect(stateless.message).toContain("with a session id");
    expect(s.seen.filter((r) => r.rpc === "tools/list" && r.session === "s-1")).toHaveLength(2);
  });

  it("fails when the tool list changes between calls, naming the tool", async () => {
    const s = await mcpServer({ unstable: true });
    const { stable } = await run(s.url);
    expect(stable.status).toBe("fail");
    expect(stable.findings[0]!.message).toContain("beta_feature");
  });

  it("reads server-sent-event responses and follows pagination", async () => {
    const s = await mcpServer({ sse: true, paginate: true });
    const { report, stable } = await run(s.url);
    expect(stable.status).toBe("pass");
    expect(report.probe!.mcp!.session.first!.tools).toEqual(["search", "export"]);
    expect(parseJsonRpc('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n', 7)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("asks for a token instead of failing when tools/list needs credentials, and sends it when given", async () => {
    const s = await mcpServer({ requireAuth: "tok-123" });
    const without = await run(s.url);
    expect(without.stable.status).toBe("not-applicable");
    expect(without.stable.message).toContain("MUSE_READY_TOKEN");
    const withToken = await run(s.url, { ...LOCAL, authHeaders: { Authorization: "Bearer tok-123" } });
    expect(withToken.stable.status).toBe("pass");
  });

  it("the CLI flag enables it and the report says what was sent", async () => {
    const s = await mcpServer();
    const dir = mkdtempSync(join(tmpdir(), "muse-ready-mcpcli-"));
    const cfg = join(dir, "c.json");
    writeFileSync(cfg, JSON.stringify({ profile: "mcp", connector: { serverUrl: s.url, auth: "bearer" } }));
    // Exit code 1 is expected: NET001 rightly blocks a server on 127.0.0.1. We only need the output.
    const stdout: string = await exec("node", [join(root, "dist/cli/index.js"), toolsFile(), "-c", cfg, "--probe-mcp", "--probe-allow-private", "--no-color"], { cwd: root }).then(
      (r) => r.stdout,
      (e) => e.stdout,
    );
    expect(stdout).toContain("JSON-RPC initialize and tools/list only");
    expect(stdout).toMatch(/MCP004[\s\S]*The same 1 tools came back on every call/);
  });
});
