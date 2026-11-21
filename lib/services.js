// Assemblage des services partagés (sidebar et options) : config, embeddings, recherche RAG, registre d'outils.
import { loadConfig } from "./storage.js";
import { embed } from "./llm.js";
import * as ragdb from "./ragdb.js";
import { ToolRegistry } from "./tools.js";

export function createServices() {
  const getConfig = () => loadConfig();

  /** cfg = { providerId, model } enregistrés dans la collection : on embarque la requête avec le même modèle. */
  const getEmbedder = async (cfg) => {
    const { providers } = await loadConfig();
    const p = providers.find((x) => x.id === cfg.providerId);
    if (!p) return null;
    return (texts, signal) => embed(p, cfg.model, texts, { signal });
  };

  const ragSearch = (params) => ragdb.search({ ...params, getEmbedder });

  const registry = new ToolRegistry({
    getConfig,
    listCollections: ragdb.listCollections,
    ragSearch,
  });

  return { getConfig, getEmbedder, ragSearch, registry };
}
