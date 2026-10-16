// Minimal offline OpenAI Responses-API provider for issue #173073 evidence.
// Drives codex to call the MCP tool once, then finish.
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.PORT || "8791");
const LOG = process.env.PROVIDER_LOG || "/tmp/provider-requests.jsonl";
const TARGET_HINT = process.env.MCP_TOOL_HINT || "probe";

const log = (entry) => {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
};

const sse = (res, events) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
};

function collectTools(body) {
  const out = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (!t || typeof t !== "object") continue;
    if (t.type === "namespace" && Array.isArray(t.tools)) {
      for (const c of t.tools) out.push({ name: c.name, namespace: t.name });
    } else if (t.name) {
      out.push({ name: t.name, namespace: undefined });
    }
  }
  return out;
}

function created(id) {
  return {
    type: "response.created",
    response: {
      id,
      object: "response",
      status: "in_progress",
      output: [],
      created_at: Math.floor(Date.now() / 1000),
    },
  };
}

function finalMessage(id, text) {
  const item = { type: "message", id: `${id}_m`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    created(id),
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
  ];
}

function functionCall(id, call, tool) {
  const item = { type: "function_call", id: call.id, call_id: call.call_id, name: tool.name, arguments: call.arguments, ...(tool.namespace ? { namespace: tool.namespace } : {}) };
  return [
    created(id),
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: call.arguments },
    { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, name: tool.name, arguments: call.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
  ];
}

const server = http.createServer((req, res) => {
  const url = req.url || "";
  if (req.method === "GET" && url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ id: "mock-codex", object: "model" }],
        models: [
          {
            slug: "mock-codex",
            display_name: "mock-codex",
            description: "offline evidence model",
            default_reasoning_level: "low",
            supported_reasoning_levels: [{ effort: "low", description: "fast" }],
            shell_type: "shell_command",
            visibility: "list",
            supported_in_api: true,
            priority: 0,
            availability_nux: null,
            upgrade: null,
            base_instructions: "You are Codex.",
            include_skills_usage_instructions: false,
            supports_reasoning_summary_parameter: false,
            default_reasoning_summary: "none",
            support_verbosity: false,
            default_verbosity: "low",
            apply_patch_tool_type: "freeform",
            web_search_tool_type: "text",
            truncation_policy: { mode: "tokens", limit: 10000 },
            supports_parallel_tool_calls: true,
            supports_image_detail_original: false,
            context_window: 128000,
            max_context_window: 128000,
            effective_context_window_percent: 95,
            experimental_supported_tools: [],
            input_modalities: ["text"],
            supports_search_tool: false,
            tool_mode: "direct",
          },
        ],
      }),
    );
    return;
  }
  if (req.method !== "POST" || !url.startsWith("/v1/responses")) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {}
    const tools = collectTools(body);
    const input = Array.isArray(body.input) ? body.input : [];
    const hasToolOutput = input.some((i) => i && typeof i === "object" && String(i.type).endsWith("_output"));
    log({ kind: "responses", model: body.model, hasToolOutput, toolNames: tools.map((t) => t.name), inputTypes: input.map((i) => i && i.type) });
    const id = `resp_${Math.random().toString(36).slice(2)}`;
    if (hasToolOutput) {
      sse(res, finalMessage(id, "DONE"));
      return;
    }
    const tool = tools.find((t) => (t.name || "").includes(TARGET_HINT)) || tools.find((t) => (t.name || "").startsWith("mcp"));
    if (!tool) {
      sse(res, finalMessage(id, `NO_TOOL_FOUND::${JSON.stringify(tools.map((t) => t.name))}`));
      return;
    }
    sse(res, functionCall(id, { id: "fc_1", call_id: "call_1", arguments: JSON.stringify({ q: "reconcile" }) }, tool));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log({ kind: "listening", port: PORT });
  process.stdout.write(`MOCK_PROVIDER_READY ${PORT}\n`);
});
