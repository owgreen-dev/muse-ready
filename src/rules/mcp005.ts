import type { Rule } from "../core/types.js";

export const MCP005: Rule = {
  id: "MCP005",
  title: "Live: answers tools/list without a session",
  category: "spec",
  severity: "low",
  subscores: ["custom"],
  appliesTo: ["mcp"],
  rationale:
    "The MCP 2026-07-28 revision made the core stateless, with no initialize handshake required, so clients can call a server without holding a session. Servers that still require one keep working with older clients. Checked with --probe-mcp, which sends only initialize and tools/list.",
  run({ probe }) {
    const mcp = probe?.mcp;
    if (!mcp) return { status: "not-applicable", message: "Live check. Run with --probe-mcp to include it." };
    const s = mcp.stateless;
    if (s.status === 401 || s.status === 403) return { status: "not-applicable", message: "tools/list needs credentials. Set MUSE_READY_TOKEN to check it." };
    if (s.fingerprint) return { status: "pass", message: `tools/list works without initialize or a session (${s.tools?.length ?? 0} tools).` };
    if (mcp.session.first?.fingerprint) {
      return {
        status: "warn",
        message: `tools/list only works after initialize${mcp.session.usedSessionId ? " and with a session id" : ""}; MCP 2026-07-28 clients may not send one.`,
        findings: s.error ? [{ message: `Without a session: ${s.error}` }] : [],
      };
    }
    return { status: "not-applicable", message: "tools/list didn't work in either mode; see MCP004." };
  },
};
