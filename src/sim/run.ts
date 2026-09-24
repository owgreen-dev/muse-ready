// Runs scenarios through a model acting as the agent. Tool calls are answered from the spec, never the network.
import type { LoadedInput } from "../core/types.js";
import { chat, type ChatMessage, type ChatTool, type ModelConfig } from "./client.js";
import { grade, type ActualCall, type Scenario } from "./scenarios.js";
import { buildTools } from "./tools.js";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a personal AI agent acting for the user. Use the available tools to complete their request. " +
  "If the request is ambiguous, or would delete data, spend money or send something on their behalf, you may ask the user a short question instead of acting.";

export interface SimulateOptions {
  model: ModelConfig;
  runs?: number;
  maxTurns?: number;
  systemPrompt?: string;
}

export interface RunResult {
  pass: boolean;
  reasons: string[];
  calls: ActualCall[];
  turns: number;
  /** The agent's final words, trimmed, when it answered without a tool. */
  reply?: string;
  error?: string;
}

export interface ScenarioResult {
  id: string;
  request: string;
  passed: number;
  runs: RunResult[];
}

export interface SimulationResult {
  model: string;
  runs: number;
  passRate: number;
  scenarios: ScenarioResult[];
}

async function runOnce(input: LoadedInput, scenario: Scenario, o: Required<Omit<SimulateOptions, "model">> & { model: ModelConfig }): Promise<RunResult> {
  const tools = buildTools(input);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const chatTools: ChatTool[] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: ChatMessage[] = [
    { role: "system", content: o.systemPrompt },
    { role: "user", content: scenario.request },
  ];
  const calls: ActualCall[] = [];
  let turns = 0;
  let reply: string | undefined;
  try {
    while (turns < o.maxTurns) {
      turns++;
      const msg = await chat(o.model, messages, chatTools);
      messages.push(msg);
      if (!msg.tool_calls?.length) {
        reply = msg.content?.trim().slice(0, 300) || undefined;
        break;
      }
      for (const tc of msg.tool_calls) {
        const tool = byName.get(tc.function?.name);
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          args = {};
        }
        calls.push({ operation: tool?.label ?? String(tc.function?.name), args });
        const answer = tool ? tool.mock() : { error: `Unknown tool ${tc.function?.name}` };
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(answer) });
      }
    }
  } catch (err) {
    return { pass: false, reasons: [`simulation error: ${(err as Error).message}`], calls, turns, error: (err as Error).message };
  }
  const g = grade(scenario, calls, input);
  const reasons = turns >= o.maxTurns && !reply ? [...g.reasons, `stopped after ${o.maxTurns} turns`] : g.reasons;
  return { pass: g.pass && reasons.length === g.reasons.length, reasons, calls, turns, reply };
}

export async function simulate(input: LoadedInput, scenarios: Scenario[], options: SimulateOptions): Promise<SimulationResult> {
  const o = { runs: options.runs ?? 3, maxTurns: options.maxTurns ?? 6, systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, model: options.model };
  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    const runs: RunResult[] = [];
    for (let i = 0; i < o.runs; i++) {
      const r = await runOnce(input, s, o);
      runs.push(r);
      // A configuration or auth error will fail every run the same way; don't burn the budget.
      if (r.error && i === 0 && /HTTP 40[13]|Refusing|base URL|No model/.test(r.error)) break;
    }
    results.push({ id: s.id, request: s.request, passed: runs.filter((r) => r.pass).length, runs });
  }
  const total = results.reduce((n, r) => n + r.runs.length, 0);
  const passed = results.reduce((n, r) => n + r.passed, 0);
  return { model: o.model.model, runs: o.runs, passRate: total ? Math.round((passed / total) * 100) : 0, scenarios: results };
}
