import type { Finding, Rule } from "../core/types.js";
import { isOAuthScheme, isStaticHeaderScheme, securitySchemes } from "../core/openapi.js";
import { aggregate } from "./util.js";

export const AUTH002: Rule = {
  id: "AUTH002",
  title: "OAuth setup is workable for an agent",
  category: "auth",
  severity: "high",
  subscores: ["custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Reports show Muse cannot sustain 10-minute PKCE tokens and that its Dynamic Client Registration is rejected by redirect-host allow-lists (imajin-ai #2252; sentinelx-cloud-core #49). Muse's OAuth callback host was observed as agent.meta.ai.",
  run({ input, connector }) {
    if (input.kind === "mcp") {
      if (connector.auth !== "oauth") return { status: "not-applicable", message: "Server is not declared as OAuth." };
      return {
        status: "warn",
        message: "OAuth-only MCP server. Muse Code sends static headers only, and consumer Muse must bridge MCP itself.",
      };
    }

    const schemes = securitySchemes(input.resolved);
    const oauth = schemes.filter((s) => isOAuthScheme(s.scheme));
    if (oauth.length === 0) return { status: "not-applicable", message: "No OAuth schemes declared." };

    const fails: Finding[] = [];
    const warns: Finding[] = [];
    const hasStatic = schemes.some((s) => isStaticHeaderScheme(s.scheme));
    if (!hasStatic) {
      warns.push({ message: "OAuth is the only way in. Offer a long-lived token as a fallback." });
    }
    for (const s of oauth) {
      const flows = s.scheme.flows ?? {};
      // Swagger 2 puts the flow name directly on the scheme.
      const names: string[] = s.scheme.flow ? [String(s.scheme.flow)] : Object.keys(flows);
      for (const name of names) {
        if (name === "implicit" || name === "password") {
          // With a static credential available Muse can ignore the OAuth flow, so this is not blocking.
          (hasStatic ? warns : fails).push({ message: `${s.name}: the ${name} flow is deprecated in OAuth 2.1`, pointer: [...s.pointer, "flows", name] });
        }
        if (name === "authorizationCode" || name === "accessCode") {
          const flow = flows[name] ?? s.scheme;
          if (!flow.refreshUrl) {
            warns.push({
              message: `${s.name}: authorization code flow declares no refreshUrl, so the agent must re-prompt the user when tokens expire`,
              pointer: [...s.pointer, "flows", name],
            });
          }
        }
      }
    }
    return aggregate(fails, warns, {
      pass: hasStatic ? "OAuth is offered alongside a static credential." : "OAuth flows look workable.",
      fail: "OAuth is the only way in and uses deprecated flows.",
      warn: "OAuth setup will be hard for Muse to use.",
    });
  },
};
