import type { McpListing, Rule } from "../core/types.js";

function needsAuth(l?: McpListing): boolean {
  return l?.status === 401 || l?.status === 403;
}

export const MCP004: Rule = {
  id: "MCP004",
  title: "Live: the MCP tool list is stable",
  category: "spec",
  severity: "medium",
  subscores: ["directory", "custom"],
  appliesTo: ["mcp"],
  rationale:
    "Agents cache and pin a server's tool list (Anthropic's API now records each fetched listing), and Muse saves custom connectors as reusable skills. A list that changes between calls breaks them. Checked with --probe-mcp, which sends only initialize and tools/list.",
  run({ probe }) {
    const mcp = probe?.mcp;
    if (!mcp) return { status: "not-applicable", message: "Live check. Run with --probe-mcp to include it." };
    const { first, second } = mcp.session;
    if (needsAuth(first) || needsAuth(mcp.stateless)) {
      return { status: "not-applicable", message: "tools/list needs credentials. Set MUSE_READY_TOKEN to check it." };
    }
    if (!mcp.session.initialized) return { status: "fail", message: `The server did not complete initialize: ${mcp.session.error ?? "unknown error"}.` };
    if (!first?.fingerprint || !second?.fingerprint) {
      return { status: "fail", message: `tools/list failed: ${first?.error ?? second?.error ?? "unknown error"}.` };
    }
    const listings = [first, second, ...(mcp.stateless.fingerprint ? [mcp.stateless] : [])];
    const distinct = new Set(listings.map((l) => l.fingerprint));
    if (distinct.size > 1) {
      const names = listings.map((l) => l.tools ?? []);
      const all = new Set(names.flat());
      const unstable = [...all].filter((n) => names.some((list) => !list.includes(n)));
      return {
        status: "fail",
        message: "The tool list changed between calls.",
        findings: [{ message: unstable.length ? `Tools that came and went: ${unstable.join(", ")}` : "Same tool names, but descriptions or input schemas changed" }],
      };
    }
    return { status: "pass", message: `The same ${first.tools?.length ?? 0} tools came back on every call.` };
  },
};
