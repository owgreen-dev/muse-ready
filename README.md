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

### In CI

```yaml
- run: npx muse-ready openapi.yaml --sarif muse-ready.sarif --fail-under 80
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: muse-ready.sarif
```

## Configuration

Put `muse-ready.config.json` (or `.yaml`) in the directory you run from, or pass `--config`. See [`muse-ready.config.example.json`](muse-ready.config.example.json).

```json
{
  "rules": { "IDEM001": "off", "SPEC002": "low" },
  "failUnder": 80,
  "connector": {
    "privacyPolicyUrl": "https://example.com/privacy",
    "termsUrl": "https://example.com/terms",
    "iconUrl": "https://example.com/icon.png",
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
| [DESC001](#desc001) | Every operation or tool is described | high | openapi, mcp | directory, custom |
| [AUTH001](#auth001) | Accepts a static bearer token or API-key header | critical | openapi, mcp | directory, custom |
| [AUTH002](#auth002) | OAuth setup is workable for an agent | high | openapi, mcp | custom |
| [SCOPE001](#scope001) | Read operations have no side effects | high | openapi, mcp | directory, custom |
| [SCOPE002](#scope002) | Write operations are clearly marked as writes | high | openapi, mcp | directory, custom |
| [SCOPE003](#scope003) | High-impact actions take a confirm or dry-run parameter | medium | openapi, mcp | directory, custom |
| [IDEM001](#idem001) | Create operations accept an idempotency key | medium | openapi | custom |
| [INJ001](#inj001) | Descriptions contain no hidden instructions | critical | openapi, mcp | directory, custom |
| [ERR001](#err001) | Rate limits and auth errors are documented | high | openapi | custom |
| [PAGE001](#page001) | List endpoints are paginated | medium | openapi | custom |
| [NET001](#net001) | API is on a public HTTPS host | critical | openapi, mcp | directory, custom |
| [META001](#meta001) | Directory listing metadata is complete | high | openapi, mcp | directory |
| [META002](#meta002) | Spec is published at a public URL | high | openapi | directory, custom |

### SPEC001

**OpenAPI document is valid.** Muse builds its REST client from the OpenAPI document. An invalid document means guessed endpoints and failed calls.

### SPEC002

**Uses OpenAPI 3.1.** Meta names no OpenAPI version. 3.1 has the widest current tool support and aligns with JSON Schema, so it is the safest target (inference, not a Meta rule).

### MCP001

**MCP tool definitions are well-formed.** The MCP spec requires each tool to have a unique name and an object inputSchema. Clients reject or mis-route malformed tools.

### DESC001

**Every operation or tool is described.** The agent picks which call to make from names and descriptions alone. Missing or one-word descriptions cause wrong or skipped calls.

### AUTH001

**Accepts a static bearer token or API-key header.** Muse stores one pasted credential in its Secure Credentials Store and Sentinel injects it at egress. Static bearer and API-key headers fit that flow; OAuth-only servers have been reported to fail (Parallel hands-on test, Sept 14 2026; imajin-ai #2252).

### AUTH002

**OAuth setup is workable for an agent.** Reports show Muse cannot sustain 10-minute PKCE tokens and that its Dynamic Client Registration is rejected by redirect-host allow-lists (imajin-ai #2252; sentinelx-cloud-core #49). Muse's OAuth callback host was observed as agent.meta.ai.

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

### PAGE001

**List endpoints are paginated.** Muse's response-size and timeout limits are undocumented. Unbounded lists risk truncation and burn the user's weekly token meter. Pagination parameters let the agent ask for less.

### NET001

**API is on a public HTTPS host.** Muse's VM lives in Meta's cloud, so laptop and private-network servers are unreachable, and Sentinel blocks hostnames that resolve to private IPs (Meta, 'How We Built Safety Into Muse'). This check reads declared URLs only; it does not resolve DNS or test TLS yet.

### META001

**Directory listing metadata is complete.** Directory submissions are reviewed for 'functional, security and legal requirements' (muse.ai/platform). Meta publishes no checklist yet, so this asks for what every app directory requires: name, description, icon, privacy policy and terms.

### META002

**Spec is published at a public URL.** The clean path for a Muse custom connector is handing it a public, unauthenticated OpenAPI URL (Parallel hands-on test). A spec behind a login wall forces Muse to scrape docs instead.


## Not yet

- Live probing of a running API: TLS, DNS, latency, real 429 and error bodies, response sizes.
- An optional LLM judge for description quality and injection surfaces in API output.
- A GitHub Action wrapper and HTML report.
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
