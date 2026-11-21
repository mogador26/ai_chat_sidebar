// Accès à browser.storage.local (avec repli mémoire pour les tests Node).
import { uid } from "./util.js";

const api = globalThis.browser ?? globalThis.chrome;

function memoryArea() {
  const m = new Map();
  return {
    async get(keys) {
      if (keys == null) return Object.fromEntries(m);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) {
        if (m.has(k)) out[k] = structuredClone(m.get(k));
        else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k];
      }
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) m.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) m.delete(k);
    },
  };
}

const area = api?.storage?.local ?? memoryArea();

export const DEFAULT_SETTINGS = {
  activeProviderId: null,
  activeModel: "",
  modelByProvider: {}, // dernier modèle utilisé par fournisseur
  systemPrompt: "Tu es un assistant utile et concis. Réponds dans la langue de l'utilisateur.",
  temperature: null, // null = valeur par défaut du serveur
  maxTokens: 4096, // utilisé par l'API Anthropic (obligatoire)
  maxToolRounds: 8,
  maxToolResultChars: 20000,
  toolsEnabled: true,
  confirmTools: true,
  disabledTools: [], // clés d'approbation d'outils désactivés
  approvedTools: [], // clés d'approbation "toujours autoriser"
  ragCollectionIds: [], // collections locales actives dans le chat
  ragAutoInject: false,
  ragTopK: 5,
  ragChunkSize: 1000,
  ragChunkOverlap: 150,
  embedding: { providerId: null, model: "" },
  // Recherche web (outils web_search / web_fetch)
  webSearchEnabled: false,
  webEngine: "duckduckgo", // duckduckgo | searxng | brave
  webSearchUrl: "", // instance SearXNG
  webSearchToken: "", // clé API (Brave) ou jeton SearXNG
  webMaxResults: 5,
  webFetchEnabled: true, // autorise aussi la lecture du contenu des pages
  // Limite de débit (HTTP 429) : attente avant de proposer la relance
  rateLimitWaitSec: 180,
  rateLimitAutoRetry: false, // relancer automatiquement à la fin de l'attente (3 fois au plus)
  // Ouverture du bouton de la barre d'outils : "sidebar" ou "popup"
  openMode: "sidebar",
};

async function getKey(key, fallback) {
  const r = await area.get(key);
  return r[key] === undefined ? fallback : r[key];
}

export async function loadConfig() {
  const r = await area.get(["providers", "mcpServers", "remoteRag", "settings"]);
  return {
    providers: r.providers ?? [],
    mcpServers: r.mcpServers ?? [],
    remoteRag: r.remoteRag ?? [],
    settings: { ...DEFAULT_SETTINGS, ...(r.settings ?? {}) },
  };
}

export const saveProviders = (list) => area.set({ providers: list });
export const saveMcpServers = (list) => area.set({ mcpServers: list });
export const saveRemoteRag = (list) => area.set({ remoteRag: list });

export async function saveSettings(patch) {
  const cur = await getKey("settings", {});
  const next = { ...DEFAULT_SETTINGS, ...cur, ...patch };
  await area.set({ settings: next });
  return next;
}

/** Appelle cb() quand la configuration change (autre page, onglet d'options…). */
export function onConfigChanged(cb) {
  if (!api?.storage?.onChanged) return () => {};
  const fn = (changes, areaName) => {
    if (areaName !== "local") return;
    if (["providers", "mcpServers", "remoteRag", "settings"].some((k) => k in changes)) cb(changes);
  };
  api.storage.onChanged.addListener(fn);
  return () => api.storage.onChanged.removeListener(fn);
}

export function newProvider(partial = {}) {
  return {
    id: uid("p_"),
    name: "",
    type: "openai", // "openai" (compatible) | "anthropic"
    baseUrl: "",
    token: "",
    headers: {},
    models: [],
    defaultModel: "",
    enabled: true,
    ...partial,
  };
}

export function newMcpServer(partial = {}) {
  return {
    id: uid("m_"),
    name: "",
    url: "",
    token: "",
    headers: {},
    transport: "auto", // "auto" | "streamable" | "sse"
    enabled: true,
    ...partial,
  };
}

export function newRemoteRag(partial = {}) {
  return {
    id: uid("r_"),
    name: "",
    description: "Recherche dans une base documentaire externe.",
    url: "",
    token: "",
    headers: {},
    bodyTemplate: '{"query": "{{query}}", "top_k": {{top_k}}}',
    resultPath: "",
    enabled: true,
    ...partial,
  };
}

// ---- Conversations -------------------------------------------------------

const convKey = (id) => `conv:${id}`;

export async function listConversations() {
  const idx = await getKey("convIndex", []);
  return [...idx].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadConversation(id) {
  return getKey(convKey(id), null);
}

export function newConversation(partial = {}) {
  const now = Date.now();
  return { id: uid("c_"), title: "Nouvelle conversation", createdAt: now, updatedAt: now, messages: [], ...partial };
}

export async function saveConversation(conv) {
  conv.updatedAt = Date.now();
  await area.set({ [convKey(conv.id)]: conv });
  const idx = await getKey("convIndex", []);
  const entry = { id: conv.id, title: conv.title, updatedAt: conv.updatedAt };
  const i = idx.findIndex((e) => e.id === conv.id);
  if (i === -1) idx.push(entry);
  else idx[i] = entry;
  await area.set({ convIndex: idx });
}

export async function deleteConversation(id) {
  await area.remove(convKey(id));
  const idx = await getKey("convIndex", []);
  await area.set({ convIndex: idx.filter((e) => e.id !== id) });
}

export async function deleteAllConversations() {
  const idx = await getKey("convIndex", []);
  await area.remove(idx.map((e) => convKey(e.id)));
  await area.set({ convIndex: [] });
}

export async function getLastConversationId() {
  return getKey("lastConversationId", null);
}
export const setLastConversationId = (id) => area.set({ lastConversationId: id });
