// Client MCP (Model Context Protocol) pour serveurs distants.
//  - Transport "Streamable HTTP" (spec 2025-03-26 / 2025-06-18) : POST JSON-RPC, réponse JSON ou SSE.
//  - Repli sur l'ancien transport "HTTP + SSE" (spec 2024-11-05) : GET SSE puis POST vers l'endpoint annoncé.
// Une extension de navigateur ne peut pas lancer de processus (stdio) : seuls les serveurs HTTP sont supportés.
import { parseSSE } from "./sse.js";
import { withTimeout, safeJsonParse } from "./util.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "ai-chat-sidebar", version: "1.0.0" };

export class McpError extends Error {
  constructor(message, { code, data, status } = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
    this.status = status;
  }
}
export class McpSessionExpired extends McpError {}

const isReply = (x, id) => x && x.id === id && (x.result !== undefined || x.error !== undefined) && !x.method;

function replyOrThrow(reply) {
  if (reply.error) {
    throw new McpError(reply.error.message || "Erreur MCP", { code: reply.error.code, data: reply.error.data });
  }
  return reply.result;
}

// ---- Transport Streamable HTTP ------------------------------------------------

class StreamableHttpTransport {
  constructor({ url, headers, fetchImpl, onServerMessage }) {
    this.kind = "streamable";
    this.url = url;
    this.headers = headers;
    this.fetch = fetchImpl;
    this.onServerMessage = onServerMessage;
    this.sessionId = null;
    this.protocolVersion = null;
    this.nextId = 1;
  }

  async request(method, params, { signal, timeoutMs = 60000 } = {}) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    return replyOrThrow(await this._post(msg, { signal, timeoutMs, expectReply: true }));
  }

  async notify(method, params, { signal, timeoutMs = 20000 } = {}) {
    const msg = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    await this._post(msg, { signal, timeoutMs, expectReply: false });
  }

  async respond(id, payload) {
    await this._post({ jsonrpc: "2.0", id, ...payload }, { timeoutMs: 10000, expectReply: false });
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.fetch(this.url, { method: "DELETE", headers: { ...this.headers, "Mcp-Session-Id": this.sessionId } });
    } catch {
      /* le serveur peut refuser DELETE : sans importance */
    }
    this.sessionId = null;
  }

  async _post(msg, { signal, timeoutMs, expectReply }) {
    const t = withTimeout(timeoutMs, signal);
    try {
      const headers = {
        ...this.headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
      if (this.protocolVersion && msg.method !== "initialize") headers["MCP-Protocol-Version"] = this.protocolVersion;

      const res = await this.fetch(this.url, { method: "POST", headers, body: JSON.stringify(msg), signal: t.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 404 && this.sessionId && msg.method !== "initialize") {
          throw new McpSessionExpired("Session MCP expirée.", { status: 404 });
        }
        throw new McpError(`HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}${text ? " : " + text.slice(0, 300) : ""}`, {
          status: res.status,
        });
      }
      if (msg.method === "initialize") {
        const sid = res.headers.get("mcp-session-id");
        if (sid) this.sessionId = sid;
      }
      if (!expectReply) {
        await res.body?.cancel().catch(() => {});
        return null;
      }

      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("text/event-stream")) {
        for await (const ev of parseSSE(res.body)) {
          const m = safeJsonParse(ev.data);
          if (m === undefined) continue;
          for (const x of Array.isArray(m) ? m : [m]) {
            if (isReply(x, msg.id)) return x;
            this.onServerMessage?.(x);
          }
        }
        throw new McpError("Flux SSE terminé sans réponse du serveur.");
      }

      const j = safeJsonParse(await res.text());
      if (j === undefined) throw new McpError(`Réponse MCP invalide (type de contenu : ${ct || "inconnu"}).`);
      let reply = null;
      for (const x of Array.isArray(j) ? j : [j]) {
        if (isReply(x, msg.id)) reply = x;
        else this.onServerMessage?.(x);
      }
      if (!reply) throw new McpError("Réponse MCP sans résultat.");
      return reply;
    } catch (e) {
      if (t.timedOut) throw new McpError(`Délai dépassé (${Math.round(timeoutMs / 1000)} s) pour ${msg.method ?? "réponse"}.`);
      throw e;
    } finally {
      t.dispose();
    }
  }
}

// ---- Transport historique HTTP + SSE ------------------------------------------

class LegacySseTransport {
  constructor({ url, headers, fetchImpl, onServerMessage }) {
    this.kind = "sse";
    this.url = url;
    this.headers = headers;
    this.fetch = fetchImpl;
    this.onServerMessage = onServerMessage;
    this.protocolVersion = null;
    this.nextId = 1;
    this.pending = new Map();
    this.endpoint = null;
    this.closedError = null;
    this.abort = new AbortController();
  }

  async start({ signal, timeoutMs = 15000 } = {}) {
    const res = await this.fetch(this.url, {
      method: "GET",
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal: this.abort.signal,
    });
    const ready = new Promise((resolve, reject) => {
      this._resolveEndpoint = resolve;
      this._rejectEndpoint = reject;
    });
    ready.catch(() => {}); // évite un "unhandled rejection" si personne n'attend plus
    this._loop = this._readLoop(res);
    const timer = setTimeout(
      () => this._rejectEndpoint(new McpError("Délai dépassé en attendant l'événement 'endpoint' du serveur SSE.")),
      timeoutMs
    );
    const onAbort = () => this._rejectEndpoint(new McpError("Connexion annulée."));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await ready;
    } catch (e) {
      this.abort.abort();
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async _readLoop(res) {
    try {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new McpError(`HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}${text ? " : " + text.slice(0, 300) : ""}`, {
          status: res.status,
        });
      }
      for await (const ev of parseSSE(res.body)) {
        if (ev.event === "endpoint") {
          const u = new URL(ev.data.trim(), this.url);
          // Sécurité : le token serait envoyé à cet endpoint, il doit rester sur la même origine.
          if (u.origin !== new URL(this.url).origin) {
            throw new McpError("Le serveur SSE a annoncé un endpoint sur une autre origine : refusé.");
          }
          this.endpoint = u.href;
          this._resolveEndpoint();
        } else if (ev.event === "message") {
          const m = safeJsonParse(ev.data);
          if (m === undefined) continue;
          for (const x of Array.isArray(m) ? m : [m]) {
            if (x.id !== undefined && !x.method && this.pending.has(x.id)) {
              const p = this.pending.get(x.id);
              this.pending.delete(x.id);
              p.resolve(x);
            } else {
              this.onServerMessage?.(x);
            }
          }
        }
      }
      throw new McpError("Connexion SSE fermée par le serveur.");
    } catch (e) {
      this.closedError = this.abort.signal.aborted ? new McpError("Connexion fermée.") : e;
      this._rejectEndpoint?.(this.closedError);
      for (const p of this.pending.values()) p.reject(this.closedError);
      this.pending.clear();
    }
  }

  async _postMessage(msg, signal) {
    if (!this.endpoint) throw new McpError("Endpoint SSE inconnu.");
    const res = await this.fetch(this.endpoint, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(msg),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new McpError(`HTTP ${res.status}${text ? " : " + text.slice(0, 300) : ""}`, { status: res.status });
    }
    await res.body?.cancel().catch(() => {});
  }

  async request(method, params, { signal, timeoutMs = 60000 } = {}) {
    if (this.closedError) throw this.closedError;
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const t = withTimeout(timeoutMs, signal);
    const waiter = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    waiter.catch(() => {});
    const aborted = new Promise((_, reject) =>
      t.signal.addEventListener("abort", () => reject(t.signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true })
    );
    aborted.catch(() => {});
    try {
      await this._postMessage(msg, t.signal);
      return replyOrThrow(await Promise.race([waiter, aborted]));
    } catch (e) {
      this.pending.delete(id);
      if (t.timedOut) throw new McpError(`Délai dépassé (${Math.round(timeoutMs / 1000)} s) pour ${method}.`);
      throw e;
    } finally {
      t.dispose();
    }
  }

  async notify(method, params, { signal, timeoutMs = 20000 } = {}) {
    const t = withTimeout(timeoutMs, signal);
    try {
      await this._postMessage({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }, t.signal);
    } finally {
      t.dispose();
    }
  }

  async respond(id, payload) {
    const t = withTimeout(10000);
    try {
      await this._postMessage({ jsonrpc: "2.0", id, ...payload }, t.signal);
    } finally {
      t.dispose();
    }
  }

  async close() {
    this.abort.abort();
  }
}

// ---- Client -------------------------------------------------------------------

/** Convertit un résultat d'outil MCP en texte pour le modèle. */
export function mcpResultToText(result) {
  const parts = [];
  for (const c of result?.content ?? []) {
    if (c.type === "text") parts.push(c.text ?? "");
    else if (c.type === "image") parts.push(`[image ${c.mimeType ?? ""} — non transmise au modèle]`);
    else if (c.type === "audio") parts.push(`[audio ${c.mimeType ?? ""} — non transmis au modèle]`);
    else if (c.type === "resource") parts.push(c.resource?.text ?? `[ressource ${c.resource?.uri ?? ""}]`);
    else if (c.type === "resource_link") parts.push(`[lien : ${c.name ?? ""} ${c.uri ?? ""}]`.trim());
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

export class McpClient {
  /** @param {{url:string, token?:string, headers?:object, transport?:"auto"|"streamable"|"sse"}} config */
  constructor(config, { fetchImpl } = {}) {
    this.config = config;
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.transport = null;
    this.serverInfo = null;
    this.capabilities = null;
    this.onToolsChanged = null;
  }

  get headers() {
    const h = { ...(this.config.headers || {}) };
    const hasAuth = Object.keys(h).some((k) => k.toLowerCase() === "authorization");
    if (this.config.token && !hasAuth) h.Authorization = `Bearer ${this.config.token}`;
    return h;
  }

  _makeHandler(getTransport) {
    return (m) => {
      if (m?.method && m.id !== undefined) {
        // Requête du serveur vers le client.
        const t = getTransport();
        const payload =
          m.method === "ping" ? { result: {} } : { error: { code: -32601, message: `Méthode non supportée : ${m.method}` } };
        t?.respond?.(m.id, payload).catch(() => {});
      } else if (m?.method === "notifications/tools/list_changed") {
        this.onToolsChanged?.();
      }
    };
  }

  async _initialize(transport, opts) {
    const res = await transport.request(
      "initialize",
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      { signal: opts?.signal, timeoutMs: 20000 }
    );
    if (!res || typeof res !== "object") throw new McpError("Réponse 'initialize' invalide.");
    transport.protocolVersion = res.protocolVersion || MCP_PROTOCOL_VERSION;
    this.serverInfo = res.serverInfo ?? null;
    this.capabilities = res.capabilities ?? {};
    await transport.notify("notifications/initialized", undefined, { signal: opts?.signal });
  }

  async connect(opts = {}) {
    const url = this.config.url;
    if (!url) throw new McpError("URL du serveur MCP manquante.");
    const kind = this.config.transport || "auto";

    if (kind !== "sse") {
      const t = new StreamableHttpTransport({
        url,
        headers: this.headers,
        fetchImpl: this.fetch,
        onServerMessage: this._makeHandler(() => t),
      });
      try {
        await this._initialize(t, opts);
        this.transport = t;
        return this;
      } catch (e) {
        const legacyCandidate =
          e instanceof McpError && e.status >= 400 && e.status < 500 && ![401, 403, 407, 429].includes(e.status);
        if (!(kind === "auto" && legacyCandidate)) throw e;
      }
    }

    const l = new LegacySseTransport({
      url,
      headers: this.headers,
      fetchImpl: this.fetch,
      onServerMessage: this._makeHandler(() => l),
    });
    await l.start(opts);
    try {
      await this._initialize(l, opts);
    } catch (e) {
      await l.close();
      throw e;
    }
    this.transport = l;
    return this;
  }

  async _rpc(method, params, opts = {}) {
    if (!this.transport) await this.connect(opts);
    try {
      return await this.transport.request(method, params, opts);
    } catch (e) {
      if (!(e instanceof McpSessionExpired)) throw e;
      await this.transport.close().catch(() => {});
      this.transport = null;
      await this.connect(opts);
      return await this.transport.request(method, params, opts);
    }
  }

  async listTools(opts = {}) {
    const tools = [];
    let cursor;
    do {
      const r = await this._rpc("tools/list", cursor ? { cursor } : {}, opts);
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  }

  async callTool(name, args, { signal, timeoutMs = 120000 } = {}) {
    const r = await this._rpc("tools/call", { name, arguments: args ?? {} }, { signal, timeoutMs });
    return { text: mcpResultToText(r), isError: !!r?.isError, raw: r };
  }

  async close() {
    try {
      await this.transport?.close();
    } finally {
      this.transport = null;
    }
  }
}
