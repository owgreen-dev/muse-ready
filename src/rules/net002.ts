import type { Rule } from "../core/types.js";
import { probeUnavailable } from "./probe-util.js";

export const NET002: Rule = {
  id: "NET002",
  title: "Live: resolves to public addresses and TLS verifies",
  category: "network",
  severity: "critical",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Sentinel blocks public hostnames that resolve to private infrastructure and the Muse VM cannot reach private networks (Meta, 'How We Built Safety Into Muse'). An invalid certificate fails before any call succeeds. Checked live with --probe.",
  run(ctx) {
    const unavailable = probeUnavailable(ctx);
    if (unavailable) return unavailable;
    const { dns, tls, target } = ctx.probe!;
    if (dns?.error) return { status: "fail", message: `${target}: ${dns.error}` };
    if (dns && dns.blocked.length) {
      return { status: "fail", message: `${target} resolves to private or reserved addresses (${dns.blocked.join(", ")}). Muse cannot reach it.` };
    }
    if (tls && !tls.verified) {
      return { status: "fail", message: tls.error ? `TLS verification failed for ${target}.` : `${target} did not answer over HTTPS.`, findings: tls.error ? [{ message: tls.error }] : [] };
    }
    if (!tls) return { status: "fail", message: `${target} is not HTTPS.` };
    return { status: "pass", message: `Resolves to public addresses (${dns?.addresses.join(", ")}) and the certificate verifies.` };
  },
};
