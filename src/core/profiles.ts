import type { RuleSetting } from "./config.js";

export interface Profile {
  id: string;
  title: string;
  description: string;
  /** Rule settings layered over each rule's default. The user's config rules win over these. */
  rules: Record<string, RuleSetting>;
  /** Why each override exists, with the source. Shown by --list-profiles. */
  reasons: Record<string, string>;
}

const MUSE_ONLY = "Muse-specific; this platform has no equivalent requirement.";

export const PROFILES: Record<string, Profile> = {
  muse: {
    id: "muse",
    title: "Meta Muse",
    description: "Muse custom connectors and the muse.ai/platform directory (default).",
    rules: { MCP002: "off" },
    reasons: { MCP002: "Muse's directory publishes no tool-title requirement." },
  },
  claude: {
    id: "claude",
    title: "Claude connectors",
    description: "Claude custom connectors and the Anthropic Connectors Directory (remote MCP).",
    rules: { AUTH001: "off", AUTH002: "high", MCP002: "high", SCOPE002: "critical", META002: "off", IDEM001: "low" },
    reasons: {
      AUTH001: "Claude connectors use OAuth for authenticated services, so a static header is not required (claude.com/docs/connectors/building/submission).",
      AUTH002: "OAuth is the expected path, so a broken OAuth setup is a real blocker.",
      MCP002: "The directory requires every tool to have a title (claude.com/docs/connectors/building/submission).",
      SCOPE002: "The directory requires readOnlyHint or destructiveHint on every tool (claude.com/docs/connectors/building/submission).",
      META002: "Claude connectors are MCP servers, not OpenAPI documents fetched by URL.",
      IDEM001: "Useful, but not a directory requirement.",
    },
  },
  "openai-apps": {
    id: "openai-apps",
    title: "ChatGPT Apps",
    description: "ChatGPT apps built with the OpenAI Apps SDK (MCP server plus OAuth 2.1).",
    rules: { AUTH001: "off", AUTH002: "high", MCP002: "medium", META002: "off" },
    reasons: {
      AUTH001: "Apps SDK authentication is OAuth 2.1 with ChatGPT as the client, so static headers are not the path (developers.openai.com/plugins/build/auth).",
      AUTH002: "OAuth 2.1 with discovery and client registration (DCR or CIMD) is required for authenticated apps.",
      MCP002: "Tool titles help ChatGPT show what an app is doing; recommended, not verified as required.",
      META002: "Apps are MCP servers, not OpenAPI documents fetched by URL.",
    },
  },
  gemini: {
    id: "gemini",
    title: "Gemini CLI",
    description: "Remote MCP servers used from Gemini CLI.",
    rules: { AUTH001: "low", AUTH002: "medium", MCP002: "low", META001: "off", META002: "off" },
    reasons: {
      AUTH001: "Gemini CLI supports OAuth discovery as well as static headers, so static auth is optional (github.com/google-gemini/gemini-cli docs/tools/mcp-server.md).",
      AUTH002: "OAuth discovery is supported; a broken setup matters but has a header fallback.",
      MCP002: "Not required by Gemini CLI.",
      META001: "Gemini CLI has no reviewed directory listing.",
      META002: MUSE_ONLY,
    },
  },
  mcp: {
    id: "mcp",
    title: "Generic MCP",
    description: "Any MCP client following the MCP authorization spec (OAuth 2.1 recommended for HTTP transports).",
    rules: { AUTH001: "low", AUTH002: "medium", MCP002: "medium", META001: "off", META002: "off" },
    reasons: {
      AUTH001: "The MCP spec recommends OAuth 2.1 for HTTP transports; many clients also accept static headers.",
      AUTH002: "OAuth is the spec's path, so it should work.",
      MCP002: "Titles are optional in the MCP spec but help every client.",
      META001: "There is no directory for generic MCP.",
      META002: MUSE_ONLY,
    },
  },
};

export const DEFAULT_PROFILE = "muse";

export function getProfile(id: string | undefined): Profile {
  const profile = PROFILES[id ?? DEFAULT_PROFILE];
  if (!profile) throw new Error(`Unknown profile "${id}". Choose one of: ${Object.keys(PROFILES).join(", ")}.`);
  return profile;
}
