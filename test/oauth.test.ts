import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check, type ProbeOptions } from "../src/index.js";
import { authorizationServerMetadataUrls, resourceMetadataUrls } from "../src/probe/oauth.js";
import { result } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse, base: string) => void) {
  const seen: { url: string; auth?: string }[] = [];
  let base = "";
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    handler(req, res, base);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen };
}

const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
const LOCAL: ProbeOptions = { request: { allowInsecureHttp: true, addressPolicy: (ip) => ip === "127.0.0.1" || ip === "::ffff:127.0.0.1" } };

const GOOD_AS = { code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, registration_endpoint: "https://as/register", authorization_response_iss_parameter_supported: true };

/** A resource server at /mcp plus a separate authorization server. */
async function setup(opts: { asMetadata?: Record<string, unknown> | null; prm?: boolean; challenge?: boolean } = {}) {
  const as = await serve((req, res) => {
    if (req.url === "/.well-known/oauth-authorization-server" && opts.asMetadata !== null) return void json(res, { issuer: "x", ...(opts.asMetadata ?? GOOD_AS) });
    res.writeHead(404).end();
  });
  const rs = await serve((req, res, base) => {
    if (req.url === "/.well-known/oauth-protected-resource/mcp" && opts.prm !== false) return void json(res, { resource: `${base}/mcp`, authorization_servers: [as.base] });
    if (req.url === "/mcp") {
      const header = opts.challenge === false ? 'Bearer realm="mcp"' : `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
      return void res.writeHead(401, { "www-authenticate": header }).end();
    }
    res.writeHead(404).end();
  });
  return { rs, as };
}

async function checkMcp(serverUrl: string, auth?: "oauth" | "bearer", probe: ProbeOptions = LOCAL) {
  const file = join(mkdtempSync(join(tmpdir(), "muse-ready-oauth-")), "tools.json");
  writeFileSync(file, JSON.stringify({ tools: [{ name: "ping", title: "Ping", description: "Checks the server is up.", inputSchema: { type: "object" } }] }));
  return result(await check(file, { config: { profile: "claude", connector: { serverUrl, ...(auth ? { auth } : {}) } }, probe }), "AUTH003");
}

describe("AUTH003 OAuth discovery", () => {
  it("builds RFC 9728 and RFC 8414 well-known URLs with path insertion", () => {
    expect(resourceMetadataUrls("https://api.example.com/mcp")).toEqual([
      "https://api.example.com/.well-known/oauth-protected-resource/mcp",
      "https://api.example.com/.well-known/oauth-protected-resource",
    ]);
    expect(authorizationServerMetadataUrls("https://auth.example.com/tenant1")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("passes a server that follows the current spec", async () => {
    const { rs } = await setup();
    const r = await checkMcp(`${rs.base}/mcp`, "oauth");
    expect(r.status, r.findings.map((f) => f.message).join("\n")).toBe("pass");
  });

  it("warns when only deprecated Dynamic Client Registration is offered, and iss is not advertised", async () => {
    const { rs } = await setup({ asMetadata: { code_challenge_methods_supported: ["S256"], registration_endpoint: "https://as/register" } });
    const r = await checkMcp(`${rs.base}/mcp`, "oauth");
    expect(r.status).toBe("warn");
    const text = r.findings.map((f) => f.message).join("\n");
    expect(text).toContain("deprecates it in favour of Client ID Metadata Documents");
    expect(text).toContain("RFC 9207");
  });

  it("fails without PKCE S256, and without protected-resource metadata", async () => {
    const noPkce = await setup({ asMetadata: { ...GOOD_AS, code_challenge_methods_supported: ["plain"] } });
    expect((await checkMcp(`${noPkce.rs.base}/mcp`, "oauth")).status).toBe("fail");
    const noPrm = await setup({ prm: false });
    const r = await checkMcp(`${noPrm.rs.base}/mcp`, "oauth");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("RFC 9728");
  });

  it("warns when 401 responses don't point to the metadata", async () => {
    const { rs } = await setup({ challenge: false });
    const r = await checkMcp(`${rs.base}/mcp`, "oauth");
    expect(r.findings.map((f) => f.message).join("\n")).toContain("resource_metadata");
  });

  it("is not applicable for static-token servers, or when an unknown MCP server has no OAuth metadata", async () => {
    const { rs } = await setup({ prm: false });
    expect((await checkMcp(`${rs.base}/mcp`, "bearer")).status).toBe("not-applicable");
    const attempted = await checkMcp(`${rs.base}/mcp`);
    expect(attempted.status).toBe("not-applicable");
    expect(attempted.message).toContain('set connector.auth to "oauth"');
  });

  it("never sends credentials during discovery", async () => {
    const { rs, as } = await setup();
    await checkMcp(`${rs.base}/mcp`, "oauth", { ...LOCAL, authHeaders: { Authorization: "Bearer should-not-be-sent" } });
    const discovery = [...rs.seen.filter((r) => r.url.startsWith("/.well-known")), ...as.seen];
    expect(discovery.length).toBeGreaterThan(1);
    expect(discovery.every((r) => r.auth === undefined)).toBe(true);
  });
});
