export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { getKieToken } from "@/lib/getKieToken";
import { getAzureToken } from "@/lib/getAzureKey";
import { parseAcpModelId } from "@/lib/agentModels";
import { runAcpChat, type ChatMessage } from "@/lib/acp/chat";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

type ErrorCode = "credits" | "auth" | "invalid" | "upstream" | "rate_limited";

// Models that use OpenAI-compatible chat/completions endpoint
const OPENAI_COMPAT_ENDPOINTS: Record<string, string> = {
  "gemini-3-flash":  "https://api.kie.ai/gemini-3-flash/v1/chat/completions",
  "gemini-3.1-pro":  "https://api.kie.ai/gemini-3.1-pro/v1/chat/completions",
  "gpt-5-2":         "https://api.kie.ai/gpt-5-2/v1/chat/completions",
};

const AZURE_API_VERSION = "2024-04-01-preview";

const SSE_HEADERS = {
  "Content-Type":      "text/event-stream",
  "Cache-Control":     "no-cache, no-transform",
  "Connection":        "keep-alive",
  "X-Accel-Buffering": "no",
};

function jsonError(status: number, error: string, code?: ErrorCode) {
  return new Response(JSON.stringify(code ? { error, code } : { error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Map an upstream failure to a calm, actionable message. Raw bodies are logged, never returned. */
function upstreamError(provider: "kie.ai" | "Azure", status: number) {
  if (status === 401 || status === 403) {
    return jsonError(401, `${provider} did not accept your API key. Check it in Settings, then retry.`, "auth");
  }
  if (status === 402) {
    return jsonError(402, `${provider} is out of credits. Top up, then retry. Your message is saved.`, "credits");
  }
  if (status === 429) {
    return jsonError(429, `${provider} is busy right now. Wait a moment, then retry.`, "rate_limited");
  }
  if (status === 400 || status === 404 || status === 422) {
    return jsonError(400, `${provider} could not handle this request. Try another model, then retry.`, "invalid");
  }
  return jsonError(502, `${provider} had a problem answering. Try again in a moment.`, "upstream");
}

async function failFromUpstream(provider: "kie.ai" | "Azure", res: Response) {
  const body = await res.text().catch(() => "");
  console.error(`[assistant] ${provider} upstream error`, res.status, body.slice(0, 500));
  let status = res.status;
  // kie.ai sometimes answers HTTP 200 with a JSON envelope carrying the real status.
  if (res.ok) {
    status = 502;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && "code" in parsed) {
        const code = Number(parsed.code);
        if (Number.isFinite(code) && code >= 400) status = code;
      }
    } catch {
      // not JSON: generic upstream failure
    }
  }
  return upstreamError(provider, status);
}

async function forward(provider: "kie.ai" | "Azure", req: NextRequest, url: string, init: RequestInit) {
  let upstream: Response;
  try {
    upstream = await fetch(url, { ...init, method: "POST", cache: "no-store", signal: req.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return new Response(null, { status: 499 });
    console.error(`[assistant] ${provider} unreachable`, err instanceof Error ? err.message : err);
    return jsonError(502, `Could not reach ${provider}. Check your connection, then retry.`, "upstream");
  }
  // A JSON body on a "successful" response is an error envelope, not a stream.
  const isJson = upstream.headers.get("content-type")?.includes("application/json");
  if (!upstream.ok || !upstream.body || isJson) return failFromUpstream(provider, upstream);
  return new Response(upstream.body, { headers: SSE_HEADERS });
}

export async function POST(req: NextRequest) {
  let body: {
    messages?: Message[];
    prompt?: string;
    systemPrompt?: string;
    system?: string;
    model?: string;
    /** Chat session / node id: lets ACP agents keep one warm session per conversation. */
    conversationId?: string;
    azureEndpoint?: string;
    azureDeployment?: string;
    azureModelName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "The request was not valid JSON.", "invalid");
  }

  const model = body.model ?? "claude-sonnet-4-6";

  // ── ACP agents (the user's own Claude Code / Codex / Gemini CLI) ───────────
  const acpModel = parseAcpModelId(model);
  if (acpModel) {
    const all = Array.isArray(body.messages) ? body.messages.filter((m) => typeof m?.content === "string") : [];
    const system = [body.system, body.systemPrompt, ...all.filter((m) => m.role === "system").map((m) => m.content)]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join("\n\n");
    const turns = all.filter((m): m is ChatMessage => m.role === "user" || m.role === "assistant");
    if (turns.length === 0 && body.prompt?.trim()) turns.push({ role: "user", content: body.prompt.trim() });
    const result = await runAcpChat({
      ...acpModel,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
      system: system || undefined,
      messages: turns,
      signal: req.signal,
    });
    if (!result.ok) return jsonError(result.status, result.error, result.code);
    return new Response(result.body, { headers: SSE_HEADERS });
  }

  let messages: Message[];

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    messages = body.messages;
  } else if (body.prompt?.trim()) {
    messages = [];
    if (body.systemPrompt?.trim()) {
      messages.push({ role: "user", content: body.systemPrompt.trim() });
      messages.push({ role: "assistant", content: "Understood." });
    }
    messages.push({ role: "user", content: body.prompt.trim() });
  } else {
    return jsonError(400, "Write a message first.", "invalid");
  }

  // ── Azure Auto (model-router) ──────────────────────────────────────────────
  if (model === "azure-auto") {
    const azureKey = await getAzureToken(req);
    if (!azureKey) {
      return jsonError(401, "No Azure API key yet. Add one in Settings, then retry.", "auth");
    }
    // Normalise: strip trailing slashes and any /openai suffix users may have pasted
    const endpoint = (body.azureEndpoint ?? "")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/openai$/i, "");
    const deployment  = (body.azureDeployment || "auto-model").trim();
    const modelName   = (body.azureModelName  || "model-router").trim();
    if (!endpoint) {
      return jsonError(400, "Azure base URL is not set. Add it in Settings → API keys, then retry.", "invalid");
    }
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_API_VERSION}`;
    return forward("Azure", req, url, {
      headers: { "api-key": azureKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: true,
        max_tokens: 8192,
        temperature: 0.7,
        top_p: 0.95,
        frequency_penalty: 0,
        presence_penalty: 0,
      }),
    });
  }

  // ── Kie.ai models ─────────────────────────────────────────────────────────
  const apiKey = await getKieToken(req);
  if (!apiKey) {
    return jsonError(401, "No kie.ai API key yet. Add one in Settings, then retry.", "auth");
  }

  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const openaiEndpoint = OPENAI_COMPAT_ENDPOINTS[model];

  if (openaiEndpoint) {
    return forward("kie.ai", req, openaiEndpoint, {
      headers,
      body: JSON.stringify({
        messages: messages.map(m => ({
          role: m.role,
          content: [{ type: "text", text: m.content }],
        })),
        stream: true,
      }),
    });
  }

  return forward("kie.ai", req, "https://api.kie.ai/claude/v1/messages", {
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      thinkingFlag: true,
      max_tokens: 4096,
    }),
  });
}
