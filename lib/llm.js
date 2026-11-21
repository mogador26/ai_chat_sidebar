// Client LLM unifié : API compatibles OpenAI (OpenAI, Mistral, Groq, OpenRouter, Ollama /v1,
// LM Studio, vLLM, LiteLLM…) et API Anthropic. Streaming, appels d'outils, liste des modèles, embeddings.
//
// Format de message interne (stocké dans les conversations) :
//   { role: "user"|"assistant"|"tool", content: string,
//     toolCalls?: [{ id, name, arguments: object, argumentsRaw: string }],   // assistant
//     toolCallId?, name?, isError? }                                          // tool
import { trimSlash, safeJsonParse, isAbortError, isLocalHost, uid, normalizeVec } from "./util.js";
import { parseSSE } from "./sse.js";

export class LLMError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.retryAfterMs = retryAfterMs; // délai demandé par le serveur (en-tête Retry-After), s'il existe
  }
}

/** Retry-After : nombre de secondes ou date HTTP. Renvoie des millisecondes, ou undefined. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return undefined;
  const v = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

// ---- Helpers ---------------------------------------------------------------

function endpoint(provider, what) {
  const base = trimSlash(provider.baseUrl);
  if (!base) throw new LLMError("URL de base manquante pour ce fournisseur.");
  if (provider.type === "anthropic") {
    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    return what === "chat" ? `${root}/messages` : `${root}/models`;
  }
  if (what === "chat") return `${base}/chat/completions`;
  if (what === "models") return `${base}/models`;
  return `${base}/embeddings`;
}

function headersFor(provider, extra = {}) {
  const h = { ...extra };
  if (provider.type === "anthropic") {
    h["anthropic-version"] = "2023-06-01";
    h["anthropic-dangerous-direct-browser-access"] = "true";
    if (provider.token) h["x-api-key"] = provider.token;
  } else if (provider.token) {
    h["Authorization"] = `Bearer ${provider.token}`;
  }
  return Object.assign(h, provider.headers || {});
}

async function httpError(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  let msg = text.slice(0, 500);
  const j = safeJsonParse(text);
  if (j) {
    const m = j.error?.message ?? j.error ?? j.message ?? j.detail ?? msg;
    msg = typeof m === "string" ? m : JSON.stringify(m);
  }
  return new LLMError(`HTTP ${res.status}${res.statusText ? " " + res.statusText : ""} : ${msg || "(réponse vide)"}`, {
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after")),
  });
}

/** Message d'erreur lisible, avec pistes de résolution. N'inclut jamais le token. */
export function describeError(e, provider) {
  if (!e) return "Erreur inconnue.";
  if (e instanceof LLMError) {
    let m = e.message;
    if (e.status === 401) m += " — vérifiez le token de ce fournisseur.";
    else if (e.status === 403 && provider?.baseUrl) {
      let local = false;
      try {
        local = isLocalHost(new URL(provider.baseUrl).hostname);
      } catch {
        /* ignore */
      }
      if (local) m += ' — pour Ollama, lancez-le avec OLLAMA_ORIGINS="moz-extension://*".';
    } else if (/wrong type/i.test(e.message) && /Expected:\s*text-generation/i.test(e.message)) {
      m += " — ce modèle n'est pas un modèle de génération de texte (c'est par exemple un modèle d'embeddings) : choisissez-en un autre dans la liste « Modèle ». Les modèles d'embeddings se règlent dans Paramètres → RAG.";
    } else if (/wrong type/i.test(e.message) && /Expected:\s*text-embeddings/i.test(e.message)) {
      m += " — ce modèle n'est pas un modèle d'embeddings : choisissez-en un autre dans Paramètres → RAG → Embeddings.";
    } else if (e.status === 429) {
      m += " — limite de requêtes atteinte (quota ou débit) : patientez avant de relancer.";
    } else if (e.status === 404) m += " — vérifiez l'URL de base (souvent terminée par /v1) et le nom du modèle.";
    return m;
  }
  if (e instanceof TypeError) {
    return `Connexion impossible (${e.message}). Vérifiez l'URL, que le serveur est démarré et que l'accès à ce site a été autorisé dans les options.`;
  }
  return e.message || String(e);
}

/** Garantit un historique valide : chaque appel d'outil a sa réponse, pas de message vide ni orphelin. */
export function normalizeHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      if (!m.content && !calls.length) continue;
      out.push(m);
      if (calls.length) {
        const ids = new Set(calls.map((c) => c.id));
        const answered = new Set();
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          if (ids.has(messages[j].toolCallId) && !answered.has(messages[j].toolCallId)) {
            answered.add(messages[j].toolCallId);
            out.push(messages[j]);
          }
          j++;
        }
        for (const c of calls) {
          if (!answered.has(c.id)) {
            out.push({ role: "tool", toolCallId: c.id, name: c.name, content: "Exécution interrompue.", isError: true });
          }
        }
        i = j - 1;
      }
    } else if (m.role === "tool") {
      continue; // orphelin
    } else {
      out.push(m);
    }
  }
  return out;
}

function finalizeToolCalls(raw) {
  return raw
    .filter((c) => c.name)
    .map((c) => {
      const id = c.id || uid("call_");
      const rawArgs = (c.argumentsRaw ?? "").trim();
      if (!rawArgs) return { id, name: c.name, arguments: {}, argumentsRaw: "{}" };
      const parsed = safeJsonParse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { id, name: c.name, arguments: parsed, argumentsRaw: rawArgs };
      }
      return {
        id,
        name: c.name,
        arguments: {},
        argumentsRaw: "{}",
        argsError: `Arguments JSON invalides : ${rawArgs.slice(0, 200)}`,
      };
    });
}

// ---- API publique -----------------------------------------------------------

/**
 * Lance une complétion en streaming.
 * @param {object} o
 * @param {object} o.provider  { type, baseUrl, token, headers }
 * @param {string} o.model
 * @param {Array}  o.messages  messages au format interne
 * @param {string} [o.system]
 * @param {Array}  [o.tools]   [{ name, description, inputSchema }]
 * @param {number|null} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {AbortSignal} [o.signal]
 * @param {(s:string)=>void} [o.onText]
 * @param {(s:string)=>void} [o.onReasoning]
 * @returns {Promise<{content:string, reasoning:string, toolCalls:Array, finishReason:string|null, aborted?:boolean}>}
 */
export async function chat(o) {
  if (!o.model) throw new LLMError("Aucun modèle sélectionné.");
  const acc = { content: "", reasoning: "" };
  try {
    return o.provider.type === "anthropic" ? await chatAnthropic(o, acc) : await chatOpenAI(o, acc);
  } catch (e) {
    if (isAbortError(e) || o.signal?.aborted) {
      return { content: acc.content, reasoning: acc.reasoning, toolCalls: [], finishReason: "aborted", aborted: true };
    }
    throw e;
  }
}

/**
 * Nature d'un modèle : "chat" (génération de texte), "embedding", "other" (reranking, classification, modération),
 * "audio" ou "image". Se base sur les métadonnées de l'API quand elles existent (`type`, `task`, `pipeline_tag`,
 * `capabilities`…), sinon sur le nom. Un modèle inconnu est considéré comme "chat".
 */
export function modelKind(id, entry) {
  const hint = [entry?.type, entry?.task, entry?.pipeline_tag, entry?.model_type]
    .filter((x) => typeof x === "string")
    .join(" ")
    .toLowerCase();
  if (hint) {
    if (/embed/.test(hint)) return "embedding";
    if (/rerank|classif|similarity|moderat/.test(hint)) return "other";
    if (/speech|audio|transcri|\basr\b|\btts\b/.test(hint) && !/text-generation|chat/.test(hint)) return "audio";
    if (/text-to-image|image-generation|diffusion/.test(hint)) return "image";
    if (/generation|chat|completion|text-to-text|conversational|llm/.test(hint)) return "chat";
  }
  const n = String(id).toLowerCase();
  if (entry?.capabilities && entry.capabilities.completion_chat === false && !/embed/.test(n)) return "other";
  if (/rerank|classif|moderation/.test(n)) return "other";
  if (/embed|(^|[/\-_:.])(bge|e5|gte|minilm|mpnet|voyage)([/\-_:.\d]|$)/.test(n)) return "embedding";
  if (/whisper|(^|[-_/])tts([-_/]|$)|text-to-speech|speech-to-text|transcri/.test(n)) return "audio";
  if (/dall-e|stable-diffusion|(^|[-_/])flux([-_/.]|$)|imagen|midjourney|sdxl/.test(n)) return "image";
  return "chat";
}

/** Type d'un modèle d'un fournisseur : celui renvoyé par l'API (mémorisé), sinon déduit du nom. */
export const kindOf = (provider, id) => provider?.modelKinds?.[id] ?? modelKind(id);

/** Modèles de génération de texte d'un fournisseur (tous les modèles si aucun n'est reconnu comme tel). */
export function chatModels(provider) {
  const all = provider?.models ?? [];
  const chat = all.filter((m) => kindOf(provider, m) === "chat");
  return chat.length ? chat : all;
}

/** Modèles d'embeddings d'un fournisseur (tous les modèles si aucun n'est reconnu comme tel). */
export function embeddingModels(provider) {
  const all = provider?.models ?? [];
  const emb = all.filter((m) => kindOf(provider, m) === "embedding");
  return emb.length ? emb : all;
}

/** Liste des modèles avec leur nature : [{ id, kind }] triée par identifiant. */
export async function listModelsDetailed(provider, { signal } = {}) {
  let url = endpoint(provider, "models");
  if (provider.type === "anthropic") url += "?limit=1000";
  const res = await fetch(url, { headers: headersFor(provider), signal });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const arr = Array.isArray(j) ? j : (j.data ?? j.models ?? []);
  const byId = new Map();
  for (const m of arr) {
    const id = typeof m === "string" ? m : (m.id ?? m.name ?? m.model);
    if (id && !byId.has(id)) byId.set(id, { id, kind: provider.type === "anthropic" ? "chat" : modelKind(id, typeof m === "string" ? null : m) });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function listModels(provider, opts) {
  return (await listModelsDetailed(provider, opts)).map((m) => m.id);
}

/** Embeddings (API compatible OpenAI uniquement). Renvoie des Float32Array normalisés. */
export async function embed(provider, model, inputs, { signal } = {}) {
  if (provider.type === "anthropic") {
    throw new LLMError("L'API Anthropic ne fournit pas d'embeddings : choisissez un fournisseur compatible OpenAI.");
  }
  if (!model) throw new LLMError("Modèle d'embeddings manquant.");
  const res = await fetch(endpoint(provider, "embeddings"), {
    method: "POST",
    headers: headersFor(provider, { "Content-Type": "application/json" }),
    body: JSON.stringify({ model, input: inputs }),
    signal,
  });
  if (!res.ok) throw await httpError(res);
  const j = await res.json();
  const data = (j.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== inputs.length) {
    throw new LLMError(`Réponse d'embeddings inattendue (${data.length} vecteurs pour ${inputs.length} textes).`);
  }
  return data.map((d) => normalizeVec(Float32Array.from(d.embedding)));
}

// ---- OpenAI-compatible --------------------------------------------------------

function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of normalizeHistory(messages)) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const o = { role: "assistant", content: m.content || (m.toolCalls?.length ? null : "") };
      if (m.toolCalls?.length) {
        o.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.argumentsRaw ?? JSON.stringify(tc.arguments ?? {}) },
        }));
      }
      out.push(o);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

async function chatOpenAI(o, acc) {
  const { provider, model, signal, tools, temperature, onText, onReasoning } = o;
  const body = { model, messages: toOpenAIMessages(o.messages, o.system), stream: true };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.inputSchema },
    }));
  }
  if (temperature != null && temperature !== "") body.temperature = Number(temperature);

  const res = await fetch(endpoint(provider, "chat"), {
    method: "POST",
    headers: headersFor(provider, { "Content-Type": "application/json", Accept: "text/event-stream" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res);

  const calls = [];
  const byIndex = new Map();
  let finish = null;

  const pushText = (s) => {
    if (!s) return;
    acc.content += s;
    onText?.(s);
  };
  const pushReasoning = (s) => {
    if (!s) return;
    acc.reasoning += s;
    onReasoning?.(s);
  };
  const addToolDelta = (tc) => {
    const fn = tc.function ?? {};
    let slot = tc.index != null ? byIndex.get(tc.index) : undefined;
    if (slot && tc.id && slot.id && tc.id !== slot.id) slot = undefined; // index réutilisé : nouvel appel
    if (!slot && tc.index == null && !tc.id) slot = calls[calls.length - 1];
    if (!slot) {
      slot = { id: "", name: "", argumentsRaw: "" };
      calls.push(slot);
      if (tc.index != null) byIndex.set(tc.index, slot);
    }
    if (tc.id) slot.id = tc.id;
    if (fn.name) slot.name = slot.name && slot.name !== fn.name ? slot.name + fn.name : fn.name;
    if (fn.arguments != null) {
      slot.argumentsRaw += typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
    }
  };

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    // Le serveur a ignoré stream:true : réponse JSON complète.
    const j = await res.json();
    if (j.error) throw new LLMError(j.error.message || JSON.stringify(j.error));
    const ch = j.choices?.[0] ?? {};
    const msg = ch.message ?? {};
    pushReasoning(msg.reasoning_content ?? msg.reasoning ?? "");
    pushText(typeof msg.content === "string" ? msg.content : "");
    (msg.tool_calls ?? []).forEach((tc, i) => addToolDelta({ ...tc, index: i }));
    finish = ch.finish_reason ?? null;
  } else {
    for await (const ev of parseSSE(res.body)) {
      if (ev.data === "[DONE]") break;
      const j = safeJsonParse(ev.data);
      if (!j) continue;
      if (j.error) throw new LLMError(j.error.message || JSON.stringify(j.error));
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      pushReasoning(typeof (d.reasoning_content ?? d.reasoning) === "string" ? (d.reasoning_content ?? d.reasoning) : "");
      pushText(typeof d.content === "string" ? d.content : "");
      for (const tc of d.tool_calls ?? []) addToolDelta(tc);
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { content: acc.content, reasoning: acc.reasoning, toolCalls: finalizeToolCalls(calls), finishReason: finish };
}

// ---- Anthropic -----------------------------------------------------------------

function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of normalizeHistory(messages)) {
    if (m.role === "user") {
      push("user", m.content ? [{ type: "text", text: m.content }] : []);
    } else if (m.role === "assistant") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments ?? {} });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [
        { type: "tool_result", tool_use_id: m.toolCallId, content: m.content || "(vide)", is_error: !!m.isError },
      ]);
    }
  }
  return out;
}

async function chatAnthropic(o, acc) {
  const { provider, model, signal, tools, temperature, onText, onReasoning } = o;
  const body = {
    model,
    max_tokens: Number(o.maxTokens) || 4096,
    messages: toAnthropicMessages(o.messages),
    stream: true,
  };
  if (o.system) body.system = o.system;
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema }));
  }
  if (temperature != null && temperature !== "") body.temperature = Number(temperature);

  const res = await fetch(endpoint(provider, "chat"), {
    method: "POST",
    headers: headersFor(provider, { "Content-Type": "application/json", Accept: "text/event-stream" }),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res);

  const blocks = [];
  let finish = null;
  for await (const ev of parseSSE(res.body)) {
    const j = safeJsonParse(ev.data);
    if (!j) continue;
    switch (j.type) {
      case "content_block_start": {
        const b = j.content_block ?? {};
        blocks[j.index] = { type: b.type, id: b.id, name: b.name, json: "" };
        if (b.type === "text" && b.text) {
          acc.content += b.text;
          onText?.(b.text);
        }
        break;
      }
      case "content_block_delta": {
        const d = j.delta ?? {};
        if (d.type === "text_delta" && d.text) {
          acc.content += d.text;
          onText?.(d.text);
        } else if (d.type === "thinking_delta" && d.thinking) {
          acc.reasoning += d.thinking;
          onReasoning?.(d.thinking);
        } else if (d.type === "input_json_delta" && blocks[j.index]) {
          blocks[j.index].json += d.partial_json ?? "";
        }
        break;
      }
      case "message_delta":
        if (j.delta?.stop_reason) finish = j.delta.stop_reason;
        break;
      case "error":
        throw new LLMError(j.error?.message || JSON.stringify(j.error ?? j));
      default:
        break;
    }
  }
  const raw = blocks
    .filter((b) => b && b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, argumentsRaw: b.json }));
  return { content: acc.content, reasoning: acc.reasoning, toolCalls: finalizeToolCalls(raw), finishReason: finish };
}
