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

export interface RuleContext {
  input: LoadedInput;
  connector: ConnectorMeta;
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
  generatedAt: string;
  input: { source: string; kind: InputKind; title?: string; version?: string };
  score: Score;
  gate: { passed: boolean; blocking: string[] };
  results: RuleResult[];
}
