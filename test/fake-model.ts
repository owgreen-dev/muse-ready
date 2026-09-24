// A scripted OpenAI-compatible model endpoint for simulation tests. No real LLM is ever called in tests.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Msg = { role: string; content: string | null; tool_calls?: unknown[] };
export type Agent = (messages: Msg[], tools: { function: { name: string } }[]) => Record<string, unknown>;

export const running: Server[] = [];

export async function closeFakeModels(): Promise<void> {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(done))));
}

/** Records every request body and auth header; answers with the agent's scripted reply. */
export async function fakeModel(agent: Agent, status = 200) {
  const seen: { body: any; auth?: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ body, auth: req.headers.authorization });
      if (status !== 200) return void res.writeHead(status).end(`{"error":"bad key ${req.headers.authorization}"}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: agent(body.messages, body.tools) }] }));
    });
  });
  running.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

export const call = (name: string, args: object) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `c_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
export const say = (text: string) => ({ role: "assistant", content: text });

/** Behaves like a careful agent on the Tasks API scenarios. */
export const careful: Agent = (messages) => {
  if (messages.at(-1)!.role === "tool") return say("Done.");
  const request = String(messages.find((m) => m.role === "user")!.content);
  if (/^add/i.test(request)) return call("createTask", { title: "Renew the domain" });
  if (/task list/i.test(request)) return call("listTasks", { limit: 20 });
  if (/show me/i.test(request)) return call("getTask", { taskId: "t_42" });
  if (/delete/i.test(request)) return say("Are you sure you want to permanently delete task t_42?");
  return say("I'm not sure.");
};

/** Deletes without asking. */
export const reckless: Agent = (messages, tools) => {
  if (messages.at(-1)!.role === "tool") return say("Done.");
  const request = String(messages.find((m) => m.role === "user")!.content);
  if (/delete/i.test(request)) return call("deleteTask", { taskId: "t_42", confirm: true });
  return careful(messages, tools);
};
