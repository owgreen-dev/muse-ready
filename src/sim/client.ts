// OpenAI-compatible chat-completions client with tool calling. The only network code in src/sim/.
import { isIP } from "node:net";

export const KEY_ENV = "MUSE_READY_LLM_KEY";

export interface ModelConfig {
  /** e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, or a local http://127.0.0.1:11434/v1 */
  baseUrl: string;
  model: string;
  /** Never logged, never included in errors or reports. */
  apiKey?: string;
  /** Default 0 for repeatable runs. null omits it (some models, e.g. GPT-5, only accept their default). */
  temperature?: number | null;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class ModelError extends Error {}

function isLocal(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || (isIP(h) === 4 && h.startsWith("127."));
}

/** Refuses configurations that would leak specs to a training tier or send them unencrypted. */
export function validateModelConfig(c: ModelConfig): void {
  if (!c.model || !c.model.trim()) throw new ModelError("No model set. Pass --model or set simulate.model in the config.");
  if (/contributor/i.test(c.model)) {
    throw new ModelError(`Refusing model "${c.model}": contributor tiers train on your prompts, which would include your API spec.`);
  }
  let url: URL;
  try {
    url = new URL(c.baseUrl);
  } catch {
    throw new ModelError("The model base URL is not a valid URL.");
  }
  if (url.username || url.password) throw new ModelError("Put the key in MUSE_READY_LLM_KEY, not in the base URL.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url.hostname))) {
    throw new ModelError("The model base URL must use HTTPS unless it points at a local model on this machine.");
  }
}

/** Error code and parameter name from an OpenAI-style error body: short fixed tokens only, never the message. */
function safeErrorDetail(body: string, apiKey?: string): { code?: string; param?: string } {
  try {
    const e = JSON.parse(body)?.error;
    const token = (v: unknown) => (typeof v === "string" && /^[\w.\-]{1,40}$/.test(v) && !(apiKey && v.includes(apiKey)) ? v : undefined);
    return { code: token(e?.code) ?? token(e?.type), param: token(e?.param) };
  } catch {
    return {};
  }
}

export async function chat(c: ModelConfig, messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> {
  validateModelConfig(c);
  const url = c.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const post = async () => {
    const temperature = c.temperature === null ? {} : { temperature: c.temperature ?? 0 };
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {}) },
        body: JSON.stringify({ model: c.model, messages, tools, tool_choice: "auto", ...temperature }),
        signal: AbortSignal.timeout(c.timeoutMs ?? 60_000),
      });
    } catch (err) {
      const why = (err as Error).name === "TimeoutError" ? "timed out" : "could not connect";
      throw new ModelError(`Model request ${why} (${new URL(url).host}).`);
    }
  };
  let res = await post();
  if (res.status === 400 && c.temperature !== null) {
    const detail = safeErrorDetail(await res.clone().text(), c.apiKey);
    if (detail.param === "temperature") {
      // The model only accepts its default temperature; remember that for the rest of the run.
      c.temperature = null;
      res = await post();
    }
  }
  if (!res.ok) {
    const { code, param } = safeErrorDetail(await res.text(), c.apiKey);
    const detail = [code, param].filter(Boolean).join(", ");
    throw new ModelError(`Model endpoint returned HTTP ${res.status}${detail ? ` (${detail})` : ""}${res.status === 401 ? `: check ${KEY_ENV}` : ""}.`);
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new ModelError("Model endpoint returned something that is not JSON.");
  }
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== "object") throw new ModelError("Model response had no message.");
  return { role: "assistant", content: typeof message.content === "string" ? message.content : null, tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined };
}
