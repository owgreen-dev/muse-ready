import type { Finding, Rule } from "../core/types.js";
import { isOAuthScheme, isStaticHeaderScheme, securitySchemes } from "../core/openapi.js";

export const AUTH001: Rule = {
  id: "AUTH001",
  title: "Accepts a static bearer token or API-key header",
  category: "auth",
  severity: "critical",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Muse stores one pasted credential in its Secure Credentials Store and Sentinel injects it at egress. Static bearer and API-key headers fit that flow; OAuth-only servers have been reported to fail (Parallel hands-on test, Sept 14 2026; imajin-ai #2252).",
  run({ input, connector }) {
    if (input.kind === "mcp") {
      switch (connector.auth) {
        case "bearer":
        case "apiKey":
          return { status: "pass", message: `Server accepts a static ${connector.auth} credential (from config).` };
        case "none":
          return { status: "pass", message: "Server needs no credentials (from config)." };
        case "oauth":
          return { status: "fail", message: "Server is OAuth-only (from config). Add a long-lived bearer or API-key option." };
        default:
          return {
            status: "not-applicable",
            message: 'A tool list does not say how the server authenticates. Set connector.auth in muse-ready.config.json.',
          };
      }
    }

    const schemes = securitySchemes(input.resolved);
    if (schemes.length === 0) {
      if (connector.auth === "none") return { status: "pass", message: "Public API with no auth (confirmed in config)." };
      return {
        status: "warn",
        message:
          'No security schemes declared. If the API needs a key, declare it so Muse asks for it. If it is public, set connector.auth to "none".',
      };
    }

    const fixed = schemes.filter((s) => isStaticHeaderScheme(s.scheme));
    if (fixed.length) return { status: "pass", message: `Static header auth available: ${fixed.map((s) => s.name).join(", ")}.` };

    const findings: Finding[] = schemes.map((s) => ({
      message: `${s.name}: ${describe(s.scheme)}`,
      pointer: s.pointer,
    }));
    const queryKey = schemes.some((s) => String(s.scheme.type).toLowerCase() === "apikey" && s.scheme.in === "query");
    if (queryKey) {
      return {
        status: "warn",
        message: "Only a query-string API key is offered. Keys in URLs end up in logs. Also accept it as a header.",
        findings,
      };
    }
    const oauthOnly = schemes.every((s) => isOAuthScheme(s.scheme));
    return {
      status: "fail",
      message: oauthOnly
        ? "OAuth-only. Muse's consumer runtime cannot hold short-lived interactive tokens. Add a long-lived bearer or API-key header."
        : "No static header credential is offered. Add a bearer token or an API-key header.",
      findings,
    };
  },
};

function describe(s: any): string {
  const type = String(s?.type ?? "unknown");
  if (type.toLowerCase() === "apikey") return `apiKey in ${s.in}`;
  if (type.toLowerCase() === "http") return `http ${s.scheme}`;
  return type;
}
