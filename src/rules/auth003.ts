import type { Finding, Rule } from "../core/types.js";
import { aggregate } from "./util.js";

export const AUTH003: Rule = {
  id: "AUTH003",
  title: "Live: OAuth discovery follows the MCP authorization spec",
  category: "auth",
  severity: "high",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Agents find your authorization server through RFC 9728 protected-resource metadata, required by MCP since the 2025-06-18 revision. The 2026-07-28 revision prefers Client ID Metadata Documents and deprecates Dynamic Client Registration, and asks servers to return iss (RFC 9207); PKCE S256 is mandatory in OAuth 2.1. Checked live with --probe using credential-free GET requests.",
  run({ probe }) {
    if (!probe) return { status: "not-applicable", message: "Live check. Run with --probe to include it." };
    const d = probe.oauth;
    if (!d) return { status: "not-applicable", message: "The server does not use OAuth." };
    const prm = d.resourceMetadata;
    if (!prm.authorizationServers?.length) {
      if (d.reason === "attempted") {
        return { status: "not-applicable", message: 'No OAuth metadata found. If the server uses OAuth, set connector.auth to "oauth" to check it.' };
      }
      return {
        status: "fail",
        message: "No protected-resource metadata (RFC 9728), so agents can't discover your authorization server.",
        findings: [{ message: `Tried ${prm.url ?? "the well-known URL"}: ${prm.error ?? `HTTP ${prm.status}`}` }],
      };
    }
    const as = d.authorizationServer;
    if (!as || as.error) {
      return { status: "fail", message: "The authorization server's metadata (RFC 8414) could not be read.", findings: as?.error ? [{ message: as.error }] : [] };
    }
    const fails: Finding[] = [];
    const warns: Finding[] = [];
    if (!as.s256) fails.push({ message: "The authorization server doesn't advertise PKCE S256 (code_challenge_methods_supported)" });
    if (!as.cimd && as.dcr) warns.push({ message: "Only Dynamic Client Registration is offered; MCP 2026-07-28 deprecates it in favour of Client ID Metadata Documents" });
    if (!as.cimd && !as.dcr) warns.push({ message: "Neither Client ID Metadata Documents nor Dynamic Client Registration is offered, so clients need pre-registration" });
    if (!as.iss) warns.push({ message: "authorization_response_iss_parameter_supported is not set (RFC 9207)" });
    const challenged = probe.requests.filter((r) => r.status === 401);
    if (challenged.length && !challenged.some((r) => /resource_metadata\s*=/.test(r.wwwAuthenticate ?? ""))) {
      warns.push({ message: "401 responses don't point to the metadata (WWW-Authenticate resource_metadata, RFC 9728 section 5.1)" });
    }
    return aggregate(fails, warns, {
      pass: "OAuth discovery, PKCE, client metadata documents and iss all follow the current MCP spec.",
      fail: "OAuth setup breaks the MCP authorization spec.",
      warn: "OAuth discovery works but lags the current MCP spec.",
    });
  },
};
