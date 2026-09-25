import type { RuleSetting } from "./config.js";

export interface Profile {
  id: string;
  title: string;
  description: string;
  /** Completes "Fix these before …" in the blocking message. */
  goal: string;
  /** Rule settings layered over each rule's default. The user's config rules win over these. */
  rules: Record<string, RuleSetting>;
  /** Why each override exists, with the source. Shown by --list-profiles. */
  reasons: Record<string, string>;
}

const MUSE_ONLY = "Muse-specific; this platform has no equivalent requirement.";
const FORM = "Muse's directory submission form (Manufact walkthrough, 22-24 Sep 2026; third-party, not Meta docs)";

export const PROFILES: Record<string, Profile> = {
  "muse-custom": {
    id: "muse-custom",
    title: "Muse custom connector",
    description: "A connector Muse builds for one user from your public API (default; alias: muse).",
    goal: "using this as a Muse custom connector",
    rules: { MCP002: "off", MCP003: "off", AUTH003: "medium" },
    reasons: {
      MCP003: "Muse publishes no structured-output requirement.",
      MCP002: "Custom connectors have no tool-title requirement.",
      AUTH003: "Custom connectors work best with a static token (AUTH001), so OAuth conformance matters less here.",
    },
  },
  "muse-directory": {
    id: "muse-directory",
    title: "Muse directory",
    description: "A reviewed listing submitted at muse.ai/platform, as a Raw API or an existing hosted MCP endpoint.",
    goal: "submitting to the Muse directory",
    rules: { AUTH001: "low", AUTH002: "high", META002: "low", MCP002: "off", MCP003: "off" },
    reasons: {
      MCP003: "Muse publishes no structured-output requirement.",
      AUTH001: `${FORM} lists "API keys" and "OAuth with PKCE" as auth options, so a static token is not required for a directory listing.`,
      AUTH002: "With OAuth accepted, a broken OAuth setup becomes the blocker.",
      META002: `${FORM} takes an API URL with an optional OpenAPI spec, so a public spec URL helps but is not required.`,
      MCP002: "The Muse form publishes no tool-title requirement.",
    },
  },
  claude: {
    id: "claude",
    title: "Claude connectors",
    description: "Claude custom connectors and the Anthropic Connectors Directory (remote MCP).",
    goal: "submitting to the Claude Connectors Directory",
    rules: { AUTH001: "off", AUTH002: "high", MCP002: "high", SCOPE002: "critical", META001: "medium", META002: "off", META003: "low", IDEM001: "low" },
    reasons: {
      AUTH001: "Claude connectors use OAuth for authenticated services, so a static header is not required (claude.com/docs/connectors/building/submission).",
      AUTH002: "OAuth is the expected path, so a broken OAuth setup is a real blocker.",
      MCP002: "The directory requires every tool to have a title (claude.com/docs/connectors/building/submission).",
      SCOPE002: "The directory requires readOnlyHint or destructiveHint on every tool (claude.com/docs/connectors/building/submission).",
      META002: "Claude connectors are MCP servers, not OpenAPI documents fetched by URL.",
      IDEM001: "Useful, but not a directory requirement.",
      META001: "The listing fields follow Muse's form; Anthropic's directory asks for similar material, so gaps still matter.",
      META003: "The 512x512 icon size comes from Muse's form, not Anthropic's.",
    },
  },
  "openai-apps": {
    id: "openai-apps",
    title: "ChatGPT Apps",
    description: "ChatGPT apps built with the OpenAI Apps SDK (MCP server plus OAuth 2.1).",
    goal: "submitting as a ChatGPT app",
    rules: { AUTH001: "off", AUTH002: "high", MCP002: "medium", META001: "medium", META002: "off", META003: "low" },
    reasons: {
      AUTH001: "Apps SDK authentication is OAuth 2.1 with ChatGPT as the client, so static headers are not the path (developers.openai.com/plugins/build/auth).",
      AUTH002: "OAuth 2.1 with discovery is required for authenticated apps. OpenAI prefers Client ID Metadata Documents; MCP 2026-07-28 deprecates Dynamic Client Registration but it still works.",
      MCP002: "Tool titles help ChatGPT show what an app is doing; recommended, not verified as required.",
      META002: "Apps are MCP servers, not OpenAPI documents fetched by URL.",
      META001: "The listing fields follow Muse's form; ChatGPT app submission asks for similar material.",
      META003: "The 512x512 icon size comes from Muse's form.",
    },
  },
  gemini: {
    id: "gemini",
    title: "Gemini CLI",
    description: "Remote MCP servers used from Gemini CLI.",
    goal: "using this from Gemini CLI",
    rules: { AUTH001: "low", AUTH002: "medium", MCP002: "low", META001: "off", META002: "off", META003: "off" },
    reasons: {
      META003: "No directory listing, so no icon.",
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
    goal: "publishing this MCP server",
    rules: { AUTH001: "low", AUTH002: "medium", MCP002: "medium", META001: "off", META002: "off", META003: "off" },
    reasons: {
      META003: "No directory listing, so no icon.",
      AUTH001: "The MCP spec recommends OAuth 2.1 for HTTP transports; many clients also accept static headers.",
      AUTH002: "OAuth is the spec's path, so it should work. Per MCP 2026-07-28, prefer Client ID Metadata Documents over the deprecated Dynamic Client Registration.",
      MCP002: "Titles are optional in the MCP spec but help every client.",
      META001: "There is no directory for generic MCP.",
      META002: MUSE_ONLY,
    },
  },
};

export const DEFAULT_PROFILE = "muse-custom";
/** Older names that keep working. */
export const PROFILE_ALIASES: Record<string, string> = { muse: "muse-custom" };

export function getProfile(id: string | undefined): Profile {
  const key = id ?? DEFAULT_PROFILE;
  const profile = PROFILES[PROFILE_ALIASES[key] ?? key];
  if (!profile) throw new Error(`Unknown profile "${id}". Choose one of: ${Object.keys(PROFILES).join(", ")}.`);
  return profile;
}
