import { isIP } from "node:net";
import type { Finding, Rule } from "../core/types.js";
import { serverUrls } from "../core/openapi.js";
import { aggregate } from "./util.js";

export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(h) === 6) return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}

/** Returns a problem description, or undefined if the URL is a public HTTPS URL. */
export function checkPublicUrl(url: string): { level: "fail" | "warn"; message: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { level: "fail", message: `${url} is not a valid absolute URL` };
  }
  if (isPrivateHost(u.hostname)) {
    return { level: "fail", message: `${url} points at a private or local host. Muse runs in Meta's cloud and cannot reach it.` };
  }
  if (u.protocol !== "https:") return { level: "fail", message: `${url} is not HTTPS` };
  return undefined;
}

export const NET001: Rule = {
  id: "NET001",
  title: "API is on a public HTTPS host",
  category: "network",
  severity: "critical",
  subscores: ["directory", "custom"],
  appliesTo: ["openapi", "mcp"],
  rationale:
    "Muse's VM lives in Meta's cloud, so laptop and private-network servers are unreachable, and Sentinel blocks hostnames that resolve to private IPs (Meta, 'How We Built Safety Into Muse'). This check reads declared URLs only; it does not resolve DNS or test TLS yet.",
  run({ input, connector }) {
    const fails: Finding[] = [];
    const warns: Finding[] = [];

    if (input.kind === "mcp") {
      if (!connector.serverUrl) {
        return { status: "not-applicable", message: "Set connector.serverUrl in muse-ready.config.json to check the MCP server's URL." };
      }
      const problem = checkPublicUrl(connector.serverUrl);
      if (!problem) return { status: "pass", message: `${connector.serverUrl} is a public HTTPS URL.` };
      return { status: problem.level, message: problem.message };
    }

    const servers = serverUrls(input.resolved);
    if (servers.length === 0) {
      if (input.isUrl) {
        const problem = checkPublicUrl(new URL(input.source).origin);
        if (problem) return { status: problem.level, message: `No servers declared, so calls go to the spec's host. ${problem.message}` };
        return { status: "warn", message: "No servers declared. Clients will assume the spec's own host. Declare the API base URL." };
      }
      return { status: "fail", message: "No servers declared, so Muse cannot tell where to send requests. Add a servers entry with the public base URL." };
    }
    for (const s of servers) {
      let url = s.url;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
        if (!input.isUrl) {
          warns.push({ message: `Relative server URL "${url}" can only be resolved against the spec's public URL. Run against that URL, or make it absolute.`, pointer: s.pointer });
          continue;
        }
        url = new URL(url, input.source).toString();
      }
      const problem = checkPublicUrl(url);
      if (problem) (problem.level === "fail" ? fails : warns).push({ message: problem.message, pointer: s.pointer });
    }
    return aggregate(fails, warns, {
      pass: servers.length === 1 ? "The server URL is public HTTPS." : `All ${servers.length} server URLs are public HTTPS.`,
      fail: "Muse will not be able to reach some declared servers.",
      warn: "Server URLs need attention.",
    });
  },
};
