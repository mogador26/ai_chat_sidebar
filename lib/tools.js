// Registre d'outils exposés au modèle :
//   - outils des serveurs MCP configurés (découverte via tools/list, appel via tools/call)
//   - "rag_search" : recherche dans les collections locales actives (IndexedDB)
//   - endpoints RAG HTTP distants (POST JSON configurable)
import { McpClient } from "./mcp.js";
import { slug, truncate, safeJsonParse, withTimeout, isAbortError } from "./util.js";
import { webSearch, webFetch, formatSearchResults, formatPage } from "./web.js";

const WIRE_MAX = 64; // limite des noms de fonctions (OpenAI / Anthropic)

function normalizeSchema(schema) {
  const s = schema && typeof schema === "object" ? { ...schema } : {};
  delete s.$schema;
  s.type = "object";
  if (!s.properties || typeof s.properties !== "object") s.properties = {};
  return s;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function formatRagResults(results, warnings = []) {
  const note = warnings.length ? `\n\n(${warnings.join(" ")})` : "";
  if (!results.length) return "Aucun résultat." + note;
  return (
    results.map((r, i) => `[${i + 1}] ${r.docName} (collection : ${r.collectionName})\n${r.text}`).join("\n\n") + note
  );
}

const TEXT_FIELDS = ["text", "content", "chunk", "snippet", "document", "page_content", "body"];

function formatRemote(data) {
  if (Array.isArray(data)) {
    if (!data.length) return "Aucun résultat.";
    return data
      .map((item, i) => {
        if (typeof item === "string") return `[${i + 1}] ${item}`;
        const f = item && TEXT_FIELDS.find((k) => typeof item[k] === "string");
        return `[${i + 1}] ${f ? item[f] : JSON.stringify(item)}`;
      })
      .join("\n\n");
  }
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

export class ToolRegistry {
  /**
   * @param {object} deps
   * @param {() => Promise<{mcpServers:Array, remoteRag:Array, settings:object}>} deps.getConfig
   * @param {() => Promise<Array>} [deps.listCollections]
   * @param {(p:{collectionIds:string[], query:string, topK:number}) => Promise<{results:Array, warnings:string[]}>} [deps.ragSearch]
   * @param {(cfg:object) => McpClient} [deps.clientFactory]
   * @param {typeof fetch} [deps.fetchImpl]
   */
  constructor({ getConfig, listCollections, ragSearch, clientFactory, fetchImpl } = {}) {
    this.getConfig = getConfig;
    this.listCollections = listCollections ?? (async () => []);
    this.ragSearch = ragSearch ?? (async () => ({ results: [], warnings: [] }));
    this.clientFactory = clientFactory ?? ((cfg) => new McpClient(cfg));
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.clients = new Map(); // serverId -> { sig, client, tools, stale, error }
    this.defs = [];
    this.status = [];
    this._byWire = new Map();
    this._queue = Promise.resolve();
  }

  list() {
    return this.defs;
  }

  /** État par source pour l'interface : [{id, type, name, ok, error, toolCount}] */
  getStatus() {
    return this.status;
  }

  /** Redécouvre les outils. Les appels sont sérialisés (pas de clients MCP en double). */
  refresh(opts = {}) {
    const run = this._queue.then(() => this._refresh(opts));
    this._queue = run.catch(() => {});
    return run;
  }

  async _refresh({ signal, force = false } = {}) {
    const cfg = await this.getConfig();
    const used = new Set();
    const wire = (prefix, name) => {
      const base = `${slug(prefix, 24)}__${slug(name, 36)}`.slice(0, WIRE_MAX - 4);
      let w = base;
      for (let n = 2; used.has(w); n++) w = `${base}_${n}`;
      used.add(w);
      return w;
    };

    const servers = cfg.mcpServers.filter((s) => s.enabled && s.url);
    for (const [id, e] of [...this.clients]) {
      if (!servers.some((s) => s.id === id)) {
        e.client.close().catch(() => {});
        this.clients.delete(id);
      }
    }

    const perServer = await Promise.all(
      servers.map(async (s) => {
        const sig = JSON.stringify([s.url, s.token, s.headers, s.transport]);
        let e = this.clients.get(s.id);
        if (e && e.sig !== sig) {
          e.client.close().catch(() => {});
          this.clients.delete(s.id);
          e = null;
        }
        if (!e) {
          const client = this.clientFactory(s);
          e = { sig, client, tools: null, stale: true, error: null };
          client.onToolsChanged = () => {
            e.stale = true;
          };
          this.clients.set(s.id, e);
        }
        if (force || e.stale || e.error) {
          try {
            e.tools = await e.client.listTools({ signal, timeoutMs: 20000 });
            e.error = null;
            e.stale = false;
          } catch (err) {
            e.error = err.message || String(err);
            e.tools = e.tools ?? [];
          }
        }
        return { s, e };
      })
    );

    const defs = [];
    const status = [];
    for (const { s, e } of perServer) {
      const name = s.name || s.url;
      for (const t of e.tools ?? []) {
        defs.push({
          wireName: wire(name, t.name),
          name: t.name,
          title: t.title || t.name,
          description: t.description || t.title || "",
          inputSchema: normalizeSchema(t.inputSchema),
          kind: "mcp",
          sourceId: s.id,
          sourceName: name,
          approvalKey: `mcp:${s.id}:${t.name}`,
        });
      }
      status.push({ id: s.id, type: "mcp", name, ok: !e.error, error: e.error, toolCount: (e.tools ?? []).length });
    }

    // RAG local
    const collections = await this.listCollections();
    const active = collections.filter((c) => (cfg.settings.ragCollectionIds ?? []).includes(c.id) && c.chunkCount > 0);
    if (active.length) {
      const names = [...new Set(active.map((c) => c.name))];
      used.add("rag_search");
      defs.push({
        wireName: "rag_search",
        name: "rag_search",
        title: "Base de connaissances locale",
        description:
          "Recherche des extraits pertinents dans la base de connaissances locale de l'utilisateur (documents importés). " +
          `Collections disponibles : ${names.join(", ")}.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Requête de recherche en langage naturel." },
            collection: { type: "string", enum: names, description: "Restreindre à une collection (optionnel)." },
            top_k: { type: "integer", minimum: 1, maximum: 20, description: "Nombre d'extraits (défaut : 5)." },
          },
          required: ["query"],
        },
        kind: "rag-local",
        sourceId: "local-rag",
        sourceName: "Base locale",
        approvalKey: "rag:local",
      });
      status.push({ id: "local-rag", type: "rag", name: "Base locale", ok: true, error: null, toolCount: 1 });
    }

    // Recherche web
    if (cfg.settings.webSearchEnabled) {
      used.add("web_search");
      defs.push({
        wireName: "web_search",
        name: "web_search",
        title: "Recherche web",
        description:
          "Recherche sur Internet (titres, URLs et extraits). À utiliser pour les informations récentes ou que tu ne connais pas ; " +
          "cite les URLs des sources dans ta réponse.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Requête de recherche (mots-clés)." },
            count: { type: "integer", minimum: 1, maximum: 10, description: "Nombre de résultats (défaut : 5)." },
          },
          required: ["query"],
        },
        kind: "web-search",
        sourceId: "web",
        sourceName: "Web",
        approvalKey: "web:search",
      });
      if (cfg.settings.webFetchEnabled !== false) {
        used.add("web_fetch");
        defs.push({
          wireName: "web_fetch",
          name: "web_fetch",
          title: "Lecture d'une page web",
          description: "Télécharge une page web (http/https) et renvoie son texte. Sert à lire en détail un résultat de recherche.",
          inputSchema: {
            type: "object",
            properties: { url: { type: "string", description: "URL complète de la page." } },
            required: ["url"],
          },
          kind: "web-fetch",
          sourceId: "web",
          sourceName: "Web",
          approvalKey: "web:fetch",
        });
      }
      status.push({ id: "web", type: "web", name: "Recherche web", ok: true, error: null, toolCount: cfg.settings.webFetchEnabled !== false ? 2 : 1 });
    }

    // RAG HTTP distant
    for (const r of cfg.remoteRag.filter((x) => x.enabled && x.url)) {
      defs.push({
        wireName: wire("rag", r.name || "recherche"),
        name: r.name || "recherche",
        title: r.name,
        description: r.description || "Recherche dans une base documentaire externe.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Requête de recherche en langage naturel." },
            top_k: { type: "integer", minimum: 1, maximum: 20, description: "Nombre de résultats (défaut : 5)." },
          },
          required: ["query"],
        },
        kind: "rag-http",
        sourceId: r.id,
        sourceName: r.name || r.url,
        approvalKey: `rag:${r.id}`,
      });
      status.push({ id: r.id, type: "rag-http", name: r.name || r.url, ok: true, error: null, toolCount: 1 });
    }

    this.defs = defs;
    this.status = status;
    this._byWire = new Map(defs.map((d) => [d.wireName, d]));
    return { tools: defs, status };
  }

  /** Exécute un outil. Renvoie { text, isError }. Les annulations sont propagées (exception). */
  async call(wireName, args, { signal } = {}) {
    const def = this._byWire.get(wireName);
    if (!def) return { text: `Outil inconnu : ${wireName}`, isError: true };
    const cfg = await this.getConfig();
    const max = cfg.settings.maxToolResultChars ?? 20000;
    try {
      let r;
      if (def.kind === "mcp") {
        const e = this.clients.get(def.sourceId);
        if (!e) throw new Error("Serveur MCP non connecté.");
        r = await e.client.callTool(def.name, args, { signal });
      } else if (def.kind === "web-search") {
        const results = await webSearch(cfg.settings, args?.query, { signal, fetchImpl: this.fetch, count: args?.count });
        r = { text: formatSearchResults(results, String(args?.query ?? "")) };
      } else if (def.kind === "web-fetch") {
        r = { text: formatPage(await webFetch(args?.url, { signal, fetchImpl: this.fetch, maxChars: max })) };
      } else if (def.kind === "rag-local") {
        r = await this._callLocalRag(args, cfg);
      } else {
        r = await this._callRemoteRag(def, args, cfg, signal);
      }
      return { text: truncate(r.text || "(résultat vide)", max), isError: !!r.isError };
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      return { text: `Erreur : ${e.message || e}`, isError: true };
    }
  }

  async _callLocalRag(args, cfg) {
    const query = String(args?.query ?? "").trim();
    if (!query) return { text: 'Paramètre "query" manquant.', isError: true };
    const topK = clamp(parseInt(args?.top_k, 10) || cfg.settings.ragTopK || 5, 1, 20);
    let ids = cfg.settings.ragCollectionIds ?? [];
    if (args?.collection) {
      const cols = await this.listCollections();
      ids = cols.filter((c) => ids.includes(c.id) && c.name === args.collection).map((c) => c.id);
      if (!ids.length) return { text: `Collection inconnue : ${args.collection}`, isError: true };
    }
    const { results, warnings } = await this.ragSearch({ collectionIds: ids, query, topK });
    return { text: formatRagResults(results, warnings) };
  }

  async _callRemoteRag(def, args, cfg, signal) {
    const src = cfg.remoteRag.find((r) => r.id === def.sourceId);
    if (!src) throw new Error("Source RAG introuvable.");
    const query = String(args?.query ?? "").trim();
    if (!query) return { text: 'Paramètre "query" manquant.', isError: true };
    const topK = clamp(parseInt(args?.top_k, 10) || cfg.settings.ragTopK || 5, 1, 20);
    const q = JSON.stringify(query).slice(1, -1); // échappement JSON de la requête
    const template = src.bodyTemplate || '{"query": "{{query}}", "top_k": {{top_k}}}';
    const body = template.replace(/\{\{(query|top_k)\}\}/g, (_, k) => (k === "query" ? q : String(topK)));
    if (safeJsonParse(body) === undefined) {
      return { text: "Le modèle de corps de requête n'est pas un JSON valide après substitution.", isError: true };
    }
    const headers = { "Content-Type": "application/json", ...(src.headers || {}) };
    const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
    if (src.token && !hasAuth) headers.Authorization = `Bearer ${src.token}`;

    const t = withTimeout(60000, signal);
    let res;
    let text;
    try {
      res = await this.fetch(src.url, { method: "POST", headers, body, signal: t.signal });
      text = await res.text();
    } finally {
      t.dispose();
    }
    if (!res.ok) return { text: `HTTP ${res.status} : ${text.slice(0, 300)}`, isError: true };
    const j = safeJsonParse(text);
    if (j === undefined) return { text };
    let data = j;
    for (const key of String(src.resultPath || "").split(".").filter(Boolean)) data = data?.[key];
    return { text: formatRemote(data) };
  }

  async close() {
    await Promise.all([...this.clients.values()].map((e) => e.client.close().catch(() => {})));
    this.clients.clear();
  }
}
