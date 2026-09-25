# muse-ready

Check whether your API is ready to become a **Meta Muse connector** before you submit it.

`muse-ready` reads an OpenAPI document or an MCP `tools/list` result and scores it 0–100 against what is publicly known about how Muse builds, authenticates, gates and reviews connectors. It runs offline, needs no API key and sends nothing anywhere.

```sh
npx muse-ready ./openapi.yaml
npx muse-ready https://api.example.com/openapi.json
npx muse-ready tools.json --kind mcp
```

```
$ npx muse-ready fixtures/bad/net001-localhost.openapi.yaml
✔ SPEC001   OpenAPI document is valid [high]
            Valid OpenAPI document.
▲ ERR001    Rate limits and auth errors are documented [high]
            Error behaviour is under-documented.
              · No operation documents a 429 response. Say how rate limiting is signalled, with Retry-After.
✖ NET001    API is on a public HTTPS host [critical]
            Muse will not be able to reach some declared servers.
              · http://localhost:3000 points at a private or local host. Muse runs in Meta's cloud and cannot reach it. (line 5)
…
Readiness 61/100 D  directory 60 · custom connector 67
Blocked by NET001. Fix these before submitting to Meta.
```

> **Meta has not published a connector spec, SDK or review checklist.** These rules encode public evidence as of the ruleset date printed in every report: Meta's own safety write-up and help center, hands-on tests, and developer reports. Each rule states its source. Expect them to change as Meta publishes more.

## What it checks

Two headline sub-scores:

- **Directory readiness:** would the connector survive Meta's "functional, security and legal" review for the Settings → Connectors directory?
- **Custom-connector readiness:** will Muse actually use the API well when a user asks it to build a connector from your spec?

Checks return `pass`, `warn` (half credit) or `fail`, weighted by severity: critical 10, high 5, medium 3, low 1. Any `fail` in **auth**, **injection** or **network** blocks the badge and makes the command exit 1, whatever the score.

## Output

| Flag | Writes |
|---|---|
| `-f terminal` (default) | Colored summary to stdout |
| `-f json` / `--json <file>` | Full machine-readable report |
| `-f md` / `--md <file>` | Markdown report for PRs and issues |
| `-f sarif` / `--sarif <file>` | SARIF 2.1.0 for GitHub code scanning |
| `--badge <file>` | [shields.io endpoint](https://shields.io/badges/endpoint-badge) JSON for a README badge |

Exit codes: `0` ready, `1` blocking failure or score below `--fail-under`, `2` could not load the input.

## GitHub Action

```yaml
permissions:
  contents: read

jobs:
  readiness:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: owgreen-dev/muse-ready@ca323056589fadc86f7711c173c59b2b2ff9e80a # v0.3.1
        with:
          spec: openapi.yaml
          fail-under: "80"
      - uses: github/codeql-action/upload-sarif@1c5b675653bb5c22dbe9b12b556ec555138e09fd # v4.38.1
        if: always()
        with:
          sarif_file: muse-ready.sarif
```

The full example is in [`docs/examples/muse-ready.yml`](docs/examples/muse-ready.yml). The step writes a readiness table to the job summary, sets the `score`, `grade` and `passed` outputs, and fails when there's a blocking problem or the score is under `fail-under`.

**Permissions.** The action itself needs none. It makes no GitHub API calls and never reads `GITHUB_TOKEN`. `contents: read` is for checking out your spec. `security-events: write` is only there so `upload-sarif` can show findings inline on pull requests, and it's granted only to that job. Pin every action to a commit SHA, as shown, so a moved tag can't change what runs. `persist-credentials: false` keeps the checkout token out of later steps. To probe secured endpoints, set `probe: "true"` and pass `MUSE_READY_TOKEN` from a repository secret through `env`.

### Without the Action

```yaml
- run: npx muse-ready openapi.yaml --sarif muse-ready.sarif --fail-under 80
```

## Live probe (`--probe`)

By default muse-ready only reads your document. With `--probe` it also calls the API's first declared server (or `connector.serverUrl` for MCP) to check what a document can't show:

| Check | Looks at |
|---|---|
| NET002 | DNS resolves to public addresses and the TLS certificate verifies |
| LAT001 | p95 latency (warn above 3 s, fail above 30 s or on timeout) |
| ERR002 | Secured operations reject unauthenticated calls with 401/403, and no error body leaks a stack trace or credential |
| PAGE002 | Default list responses stay under 256 KiB (fail above 1 MiB) |
| AUTH003 | For OAuth servers: RFC 9728 metadata, PKCE S256, client metadata documents rather than deprecated registration, and `iss` (RFC 9207), per the MCP 2026-07-28 spec |
| META003 | The listing icon is a reachable 512×512 PNG or JPEG |

The latency and size thresholds are provisional because Muse's limits are undocumented.

**Exactly what it sends:**
- Only `GET` requests: at most 8 documented operations, a repeat of each secured one without credentials, and a few repeats for latency. That's 16 requests at the most. It never sends `POST`, `PUT`, `PATCH` or `DELETE`, and a test proves it.
- It calls only operations whose path and required query parameters have an `example` or `default`, and skips anything with a request body.
- For OAuth servers, and for MCP servers whose auth type isn't set, it also fetches the public discovery documents: `/.well-known/oauth-protected-resource` and the authorization server's metadata. These are plain GETs, sent without credentials.
- It skips GETs named like actions, such as `GET /logout`, because they can still have side effects. The report lists everything it skipped and why.
- It never connects to loopback, private, link-local or cloud-metadata addresses. It checks every DNS answer and every redirect, and pins the connection to the vetted address.
- It requires HTTPS with a verified certificate. Each request has a 30 s limit and responses are cut off at about 1 MiB.
- Credentials are opt-in, as described below.

**Authenticated probing.** Set `MUSE_READY_TOKEN` to probe secured endpoints:

```sh
MUSE_READY_TOKEN=... npx muse-ready openapi.yaml --probe
```

- The token is read only from that environment variable. There is no CLI flag or config key for it, so it stays out of shell history, process lists and committed files.
- It's attached only to operations the spec marks as secured, and only on the probe target's own origin. It is never sent to the host serving the spec, and it's dropped on any redirect to another origin.
- The header comes from `probe.authHeader` in the config, else from the spec's static scheme (API-key header, bearer or basic), else `Authorization: Bearer`.
- Each secured operation is also called once without the token, so ERR002 can check that it is refused.
- The token never appears in any report. Tests check every output format against an API that echoes it back.

`--probe-allow-private` lifts the private-address and HTTPS restrictions so you can test an API on your own machine. Don't use it in CI.

## Scenarios and simulation

Rules check what a spec looks like. Scenarios check whether an agent can actually use it. A scenario file lists plain-language requests your users would make and the calls a good agent should respond with:

```yaml
version: 1
scenarios:
  - id: add-a-task
    request: "Add 'renew the domain' to our task list."
    calls:
      - operation: createTask            # operationId, "POST /tasks", or an MCP tool name
        args:
          title: { contains: "renew the domain" }
  - id: delete-needs-confirmation
    request: "Delete task t_42."
    outcome: ask                          # pass only if the agent makes no write call
```

Argument matchers are a plain value, `equals`, `contains`, `matches` (a regular expression), `present` or `oneOf`. A scenario can also `forbid` operations and require its calls to be `ordered`. Grading is plain code, not a model, so results are reproducible.

```sh
npx muse-ready openapi.yaml --init-tasks muse-ready.tasks.yaml       # starter: one read, one write, one confirm-first
npx muse-ready openapi.yaml --validate-tasks muse-ready.tasks.yaml   # check it against the spec
```

### Simulation

`--simulate` has a model play the agent for each scenario, several times, and grades every run:

```sh
export MUSE_READY_LLM_KEY=...        # never a flag or config key
npx muse-ready openapi.yaml --simulate muse-ready.tasks.yaml \
  --model <model-id> --model-base-url <openai-compatible-base-url> --runs 3
```

- **Your API is never called.** The model's tool calls are answered from your spec's examples, or from example values built from its schemas.
- **Any OpenAI-compatible endpoint works:** Meta's Model API, OpenRouter, OpenAI, or a local model at `http://127.0.0.1`, which needs no key. Use Meta's own `muse-spark` model to mirror Muse most closely.
- **Some setups are refused.** `-contributor` model tiers train on your prompts, which would include your spec, so they're rejected. Remote endpoints must use HTTPS.
- **The report shows** each scenario's pass count, what the agent called and why a run failed. The same results appear in JSON, Markdown and SARIF, with SARIF pointing at the scenario's line. Set `simulate.minPassRate` in the config to fail CI below a pass rate.
- **In the Action,** set `simulate: "true"`, `model` and `model-base-url`, and pass `MUSE_READY_LLM_KEY` from a secret through `env`. The `scenario-pass-rate` output carries the result.

## Other agent platforms

The same checks can target other agents. A profile turns rules on or off and changes their severity where the platforms genuinely differ, and each difference cites its source:

```sh
npx muse-ready tools.json --profile claude       # Claude connectors directory
npx muse-ready tools.json --profile openai-apps  # ChatGPT Apps SDK
npx muse-ready --list-profiles                   # every override and why
```

| Profile | Main differences from `muse` |
|---|---|
| `muse-custom` (default; `muse` also works) | A connector Muse builds for one user: needs a long-lived static token, and OAuth-only blocks |
| `muse-directory` | A reviewed listing at muse.ai/platform: API keys or OAuth with PKCE both accepted; a public OpenAPI spec is optional |
| `claude` | OAuth expected; every tool needs a title and a read-only or destructive annotation |
| `openai-apps` | OAuth 2.1 with client registration expected; static tokens aren't the path |
| `gemini` | OAuth or static headers both fine; no directory listing checks |
| `mcp` | Generic MCP spec: OAuth recommended, static headers accepted |

Set `profile` in the config file, or use the `profile` input in the Action. Your own `rules` settings still win.

## Configuration

Put `muse-ready.config.json` (or `.yaml`) in the directory you run from, or pass `--config`. See [`muse-ready.config.example.json`](muse-ready.config.example.json).

```json
{
  "rules": { "IDEM001": "off", "SPEC002": "low" },
  "failUnder": 80,
  "connector": {
    "company": "Example Inc.",
    "websiteUrl": "https://example.com",
    "supportEmail": "help@example.com",
    "docsUrl": "https://example.com/docs",
    "examplePrompts": ["What's on my list?", "Add milk", "Delete yesterday's note"],
    "privacyPolicyUrl": "https://example.com/privacy",
    "termsUrl": "https://example.com/terms",
    "iconUrl": "https://example.com/icon-512.png",
    "auth": "bearer",
    "serverUrl": "https://mcp.example.com/mcp"
  }
}
```

- `rules` turns a check `off` or changes its severity.
- `connector` supplies listing details an API document can't carry. OpenAPI documents can also put these under `info.x-muse`. For MCP tool lists, `auth` and `serverUrl` enable the auth and network checks.
- Set `connector.auth` to `"none"` for an API that is deliberately public.

## Input formats

- **OpenAPI** 3.1, 3.0 or Swagger 2.0, as JSON or YAML, from a file or URL. Local files resolve relative `$ref`s. Remote specs do not follow external `$ref`s yet.
- **MCP**: the result of `tools/list`, either `{ "tools": [...] }`, a full JSON-RPC response, or a bare array.

## Library use

```ts
import { check, renderMarkdown } from "muse-ready";

const report = await check("openapi.yaml");
console.log(report.score.overall, report.gate.passed);
```

## Rules

| ID | Check | Severity | Applies to | Sub-score |
|---|---|---|---|---|
| [SPEC001](#spec001) | OpenAPI document is valid | high | openapi | directory, custom |
| [SPEC002](#spec002) | Uses OpenAPI 3.1 | medium | openapi | custom |
| [MCP001](#mcp001) | MCP tool definitions are well-formed | high | mcp | directory, custom |
| [MCP002](#mcp002) | MCP tools declare a human-readable title | medium | mcp | directory |
| [DESC001](#desc001) | Every operation or tool is described | high | openapi, mcp | directory, custom |
| [SPEAK001](#speak001) | Responses include something short enough to say aloud | medium | openapi | custom |
| [AUTH001](#auth001) | Accepts a static bearer token or API-key header | critical | openapi, mcp | directory, custom |
| [AUTH002](#auth002) | OAuth setup is workable for an agent | high | openapi, mcp | custom |
| [AUTH003](#auth003) | Live: OAuth discovery follows the MCP authorization spec | high | openapi, mcp | directory, custom |
| [SCOPE001](#scope001) | Read operations have no side effects | high | openapi, mcp | directory, custom |
| [SCOPE002](#scope002) | Write operations are clearly marked as writes | high | openapi, mcp | directory, custom |
| [SCOPE003](#scope003) | High-impact actions take a confirm or dry-run parameter | medium | openapi, mcp | directory, custom |
| [IDEM001](#idem001) | Create operations accept an idempotency key | medium | openapi | custom |
| [INJ001](#inj001) | Descriptions contain no hidden instructions | critical | openapi, mcp | directory, custom |
| [ERR001](#err001) | Rate limits and auth errors are documented | high | openapi | custom |
| [ERR002](#err002) | Live: unauthenticated calls are rejected cleanly | high | openapi | custom |
| [PAGE001](#page001) | List endpoints are paginated | medium | openapi | custom |
| [PAGE002](#page002) | Live: list responses are a sensible size | medium | openapi | custom |
| [LAT001](#lat001) | Live: responds quickly | medium | openapi, mcp | custom |
| [NET001](#net001) | API is on a public HTTPS host | critical | openapi, mcp | directory, custom |
| [NET002](#net002) | Live: resolves to public addresses and TLS verifies | critical | openapi, mcp | directory, custom |
| [META001](#meta001) | Directory listing metadata is complete | high | openapi, mcp | directory |
| [META002](#meta002) | Spec is published at a public URL | high | openapi | directory, custom |
| [META003](#meta003) | Live: listing icon is a reachable 512x512 image | medium | openapi, mcp | directory |

### SPEC001

**OpenAPI document is valid.** Muse builds its REST client from the OpenAPI document. An invalid document means guessed endpoints and failed calls.

### SPEC002

**Uses OpenAPI 3.1.** Meta names no OpenAPI version. 3.1 has the widest current tool support and aligns with JSON Schema, so it is the safest target (inference, not a Meta rule).

### MCP001

**MCP tool definitions are well-formed.** The MCP spec requires each tool to have a unique name and an object inputSchema. Clients reject or mis-route malformed tools.

### MCP002

**MCP tools declare a human-readable title.** Anthropic's Connectors Directory requires a title on every tool, and clients use it to show people what the agent is doing. Off in the Muse profile, which publishes no such requirement.

### DESC001

**Every operation or tool is described.** The agent picks which call to make from names and descriptions alone. Missing or one-word descriptions cause wrong or skipped calls.

### SPEAK001

**Responses include something short enough to say aloud.** Muse answers by voice, on Ray-Ban glasses and on the Charm device (Meta Connect, 23 Sep 2026). A result needs a short name, title or summary the agent can speak, not only IDs and nested data. The 200-character limit is provisional; Meta publishes none. The live part runs with --probe.

### AUTH001

**Accepts a static bearer token or API-key header.** Muse stores one pasted credential in its Secure Credentials Store and Sentinel injects it at egress. Static bearer and API-key headers fit that flow; OAuth-only servers have been reported to fail (Parallel hands-on test, Sept 14 2026; imajin-ai #2252).

### AUTH002

**OAuth setup is workable for an agent.** Reports show Muse cannot sustain 10-minute PKCE tokens and that its Dynamic Client Registration is rejected by redirect-host allow-lists (imajin-ai #2252; sentinelx-cloud-core #49). Muse's OAuth callback host was observed as agent.meta.ai.

### AUTH003

**Live: OAuth discovery follows the MCP authorization spec.** Agents find your authorization server through RFC 9728 protected-resource metadata, required by MCP since the 2025-06-18 revision. The 2026-07-28 revision prefers Client ID Metadata Documents and deprecates Dynamic Client Registration, and asks servers to return iss (RFC 9207); PKCE S256 is mandatory in OAuth 2.1. Checked live with --probe using credential-free GET requests.

### SCOPE001

**Read operations have no side effects.** Muse auto-allows reads and gates writes behind an approval dialog enforced outside the model. A write disguised as a read skips that approval (OWASP LLM06, Excessive Agency).

### SCOPE002

**Write operations are clearly marked as writes.** The approval dialog shows the user what Muse is about to do. A write named like a read makes that prompt misleading, and unmarked MCP tools give the client nothing to gate on.

### SCOPE003

**High-impact actions take a confirm or dry-run parameter.** Deleting, paying, sending and publishing are the actions Muse's approval model exists for. A confirm or dry-run parameter gives the agent a safe first call to show the user before committing.

### IDEM001

**Create operations accept an idempotency key.** Agents retry after timeouts and ambiguous errors. Without an idempotency key, a retried POST can create duplicates or charge twice.

### INJ001

**Descriptions contain no hidden instructions.** Descriptions are fed straight to the model. Hidden Unicode and embedded instructions are the tool-poisoning pattern documented by Invariant Labs (mcp-scan) and OWASP LLM01.

### ERR001

**Rate limits and auth errors are documented.** A clear 429 with Retry-After lets the agent back off. A bare 403 'sends it down a debugging path on your dime' (Parallel). Documented error responses tell Muse what each failure means.

### ERR002

**Live: unauthenticated calls are rejected cleanly.** A secured endpoint that answers without credentials is an auth hole, and error bodies with stack traces or secrets leak internals into the agent's context (OWASP LLM02). A clear 401/403 tells Muse to ask the user for a credential. Checked live with --probe.

### PAGE001

**List endpoints are paginated.** Muse's response-size and timeout limits are undocumented. Unbounded lists risk truncation and burn the user's weekly token meter. Pagination parameters let the agent ask for less.

### PAGE002

**Live: list responses are a sensible size.** Large responses risk truncation and consume the user's weekly token meter. Muse's limit is undocumented; thresholds are provisional: warn above 256 KiB, fail above 1 MiB for a default page. Checked live with --probe.

### LAT001

**Live: responds quickly.** Muse's timeout is undocumented, and slow calls burn the user's weekly token meter while the agent waits. Thresholds are provisional: warn above 3 s p95, fail above 30 s or on timeout. Checked live with --probe.

### NET001

**API is on a public HTTPS host.** Muse's VM lives in Meta's cloud, so laptop and private-network servers are unreachable, and Sentinel blocks hostnames that resolve to private IPs (Meta, 'How We Built Safety Into Muse'). This check reads declared URLs only; it does not resolve DNS or test TLS yet.

### NET002

**Live: resolves to public addresses and TLS verifies.** Sentinel blocks public hostnames that resolve to private infrastructure and the Muse VM cannot reach private networks (Meta, 'How We Built Safety Into Muse'). An invalid certificate fails before any call succeeds. Checked live with --probe.

### META001

**Directory listing metadata is complete.** Muse's directory submission form asks for a name, description, website, example prompts, a 512x512 icon, a support email, privacy policy, terms of service and a documentation link (Manufact walkthrough of the form, 22-24 Sep 2026; third-party, not Meta docs). Set missing fields under connector in muse-ready.config.json or info.x-muse.

### META002

**Spec is published at a public URL.** The clean path for a Muse custom connector is handing it a public, unauthenticated OpenAPI URL (Parallel hands-on test). A spec behind a login wall forces Muse to scrape docs instead.

### META003

**Live: listing icon is a reachable 512x512 image.** Muse's submission form asks for a 512x512 icon (Manufact walkthrough, 22-24 Sep 2026; third-party). Checked live with --probe by reading the image header; nothing is uploaded anywhere.

## Not yet

- An optional LLM judge for description quality and injection surfaces in API output.
- An HTML report.
- Profiles for other agents (generic MCP, ChatGPT apps, Claude connectors).

## Development

```sh
npm install
npm run verify        # the gate: typecheck, tests, build and security audit
node scripts/rules-doc.mjs   # regenerate the rule catalog above after changing a rule
```

Planned work runs as an autonomous loop behind that gate. See [plans/README.md](plans/README.md) for the goal, the passing criteria, the security audit and the audit trail.

Every rule has a seeded failure in `fixtures/bad/`, and both files in `fixtures/good/` must pass every rule. Add both when you add a rule.

## License

Apache-2.0
