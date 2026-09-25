export type Severity = "critical" | "high" | "medium" | "low";
export type Status = "pass" | "warn" | "fail" | "not-applicable";
export type Category =
  | "spec"
  | "description"
  | "auth"
  | "scope"
  | "injection"
  | "errors"
  | "network"
  | "performance"
  | "metadata";
export type InputKind = "openapi" | "mcp";
/** Which headline sub-score a rule feeds. */
export type Subscore = "directory" | "custom";

/** A path into the parsed document, e.g. ["paths", "/items", "get"]. */
export type Pointer = (string | number)[];

export interface Finding {
  message: string;
  pointer?: Pointer;
  /** 1-based line in the source document, filled in by the engine when resolvable. */
  line?: number;
}

export interface RuleOutcome {
  status: Status;
  message: string;
  findings?: Finding[];
}

/** Connector metadata that an OpenAPI or MCP document cannot carry on its own. */
export interface ConnectorMeta {
  name?: string;
  description?: string;
  company?: string;
  websiteUrl?: string;
  supportEmail?: string;
  docsUrl?: string;
  /** Example requests a user might make, shown with the listing. */
  examplePrompts?: string[];
  /** 512x512 PNG or JPEG. */
  iconUrl?: string;
  privacyPolicyUrl?: string;
  termsUrl?: string;
  /** Auth the MCP server accepts. OpenAPI inputs declare this in securitySchemes instead. */
  auth?: "bearer" | "apiKey" | "oauth" | "none";
  /** Public URL of an MCP server. OpenAPI inputs use `servers` instead. */
  serverUrl?: string;
}

export interface McpTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: {
    title?: unknown;
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
    idempotentHint?: unknown;
    openWorldHint?: unknown;
  };
  [key: string]: unknown;
}

export interface LoadedInput {
  /** File path or URL as given by the user. */
  source: string;
  isUrl: boolean;
  kind: InputKind;
  raw: string;
  /** The document as parsed, with $refs left in place. */
  doc: any;
  /** OpenAPI only: the document with $refs resolved, or the raw doc if resolution failed. */
  resolved?: any;
  /** OpenAPI only: result of schema validation. */
  validation?: { valid: boolean; errors: string[]; warnings: string[]; specification?: string };
  /** MCP only: the tool list. */
  tools?: McpTool[];
}

/** One request the live probe made. Paths have query values redacted. */
export interface ProbeRequest {
  method: string;
  path: string;
  /** Operation label, e.g. "GET /items", when the request exercised a documented operation. */
  operation?: string;
  status?: number;
  ms?: number;
  bytes?: number;
  truncated?: boolean;
  /** Whether a credential was attached (never the credential itself). */
  authenticated?: boolean;
  error?: { code: string; message: string };
  /** The WWW-Authenticate header on a 401, for OAuth discovery checks. */
  wwwAuthenticate?: string;
  /** First 4 KiB of the body, for leak checks. Not included in reports. */
  bodySample?: string;
}

export interface McpListing {
  status?: number;
  /** Tool names in the order returned. */
  tools?: string[];
  /** Hash of names, descriptions and input schemas, to compare listings. */
  fingerprint?: string;
  error?: string;
}

export interface McpProbe {
  /** tools/list sent with no initialize and no session (MCP 2026-07-28 stateless core). */
  stateless: McpListing;
  /** initialize, then tools/list twice in the same session. */
  session: { initialized: boolean; protocolVersion?: string; usedSessionId: boolean; error?: string; first?: McpListing; second?: McpListing };
}

export interface OAuthDiscovery {
  /** Why discovery ran: the spec or config says OAuth, or it was tried for an MCP server with unknown auth. */
  reason: "declared" | "attempted";
  resourceMetadata: { url?: string; status?: number; authorizationServers?: string[]; error?: string };
  authorizationServer?: {
    url?: string;
    status?: number;
    s256?: boolean;
    cimd?: boolean;
    dcr?: boolean;
    iss?: boolean;
    error?: string;
  };
}

export interface ProbeResult {
  enabled: true;
  /** Base URL probed, redacted. */
  target: string;
  dns?: { addresses: string[]; blocked: string[]; error?: string };
  tls?: { verified: boolean; error?: string };
  requests: ProbeRequest[];
  /** Operations the probe skipped, with the reason. */
  skipped: { operation: string; reason: string }[];
  /** Set when the probe could not start, e.g. no server URL. */
  error?: string;
  /** MCP JSON-RPC checks, only with --probe-mcp. */
  mcp?: McpProbe;
  /** OAuth discovery (MCP authorization spec), when the server uses or advertises OAuth. */
  oauth?: OAuthDiscovery;
  /** The listing icon, fetched when connector.iconUrl is set. */
  icon?: { url: string; status?: number; contentType?: string; format?: "png" | "jpeg"; width?: number; height?: number; error?: string };
}

export interface RuleContext {
  input: LoadedInput;
  connector: ConnectorMeta;
  /** Present only when the user asked for --probe. */
  probe?: ProbeResult;
}

export interface Rule {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  subscores: Subscore[];
  appliesTo: InputKind[];
  /** Why the rule exists, with the source it rests on. */
  rationale: string;
  run(ctx: RuleContext): RuleOutcome | Promise<RuleOutcome>;
}

export interface RuleResult extends RuleOutcome {
  id: string;
  title: string;
  category: Category;
  severity: Severity;
  subscores: Subscore[];
  rationale: string;
  findings: Finding[];
}

export interface Score {
  overall: number;
  grade: string;
  directory: number | null;
  custom: number | null;
}

export interface Report {
  tool: { name: string; version: string; rulesetDate: string };
  profile: { id: string; title: string };
  generatedAt: string;
  input: { source: string; kind: InputKind; title?: string; version?: string };
  score: Score;
  gate: { passed: boolean; blocking: string[] };
  /** Scenario simulation results; absent unless --simulate was used. */
  simulation?: {
    model: string;
    runs: number;
    passRate: number;
    tasksFile: string;
    scenarios: {
      id: string;
      request: string;
      line?: number;
      passed: number;
      runs: { pass: boolean; reasons: string[]; calls: { operation: string; args: Record<string, unknown> }[]; turns: number; reply?: string }[];
    }[];
  };
  /** Summary of live probing; absent unless --probe was used. */
  probe?: { enabled: true; target: string; requests: Omit<ProbeRequest, "bodySample">[]; skipped: { operation: string; reason: string }[]; mcp?: McpProbe; error?: string };
  results: RuleResult[];
}
