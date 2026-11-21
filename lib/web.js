// Recherche web et lecture de pages pour le modèle (outils "web_search" et "web_fetch").
// Moteurs : DuckDuckGo (sans clé, page HTML), SearXNG (API JSON, instance au choix), Brave Search (clé API).
import { isLocalHost, truncate, withTimeout, safeJsonParse } from "./util.js";

export const WEB_ENGINES = {
  duckduckgo: { label: "DuckDuckGo (sans clé)", needsUrl: false, needsToken: false, origin: "https://html.duckduckgo.com" },
  searxng: { label: "SearXNG (instance au choix)", needsUrl: true, needsToken: false },
  brave: { label: "Brave Search (clé API)", needsUrl: false, needsToken: true, origin: "https://api.search.brave.com" },
};

const MAX_BODY = 2_000_000; // octets lus au maximum pour une page

const hintFor = (e) =>
  e instanceof TypeError
    ? " (connexion impossible ou accès au site non autorisé : accordez l'accès dans Paramètres → Général → Recherche web)"
    : "";

/** Lit au plus MAX_BODY octets du corps de la réponse. */
async function readCapped(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_BODY);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      out += dec.decode(value, { stream: true });
      if (n >= MAX_BODY) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

function parseHtml(html) {
  const Parser = globalThis.DOMParser;
  if (!Parser) throw new Error("DOMParser indisponible.");
  return new Parser().parseFromString(html, "text/html");
}

/** Hôtes que le modèle ne doit pas pouvoir interroger (réseau local, métadonnées cloud). */
export function isPrivateHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  return isLocalHost(h) || /^169\.254\./.test(h) || /^0\./.test(h) || h.endsWith(".local") || h.endsWith(".internal") || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || !h.includes(".") && !h.includes(":");
}

/** Texte lisible d'une page HTML : titre + contenu principal, sans scripts ni bandeaux. */
export function htmlToText(html) {
  const doc = parseHtml(html);
  const title = doc.querySelector("title")?.textContent?.trim() ?? "";
  for (const n of doc.querySelectorAll("script,style,noscript,template,svg,iframe,canvas,nav,header,footer,aside,form,select,button")) n.remove();
  const root = doc.querySelector("main, article, [role=main]") ?? doc.body ?? doc.documentElement;
  const blocks = "p,div,section,li,tr,h1,h2,h3,h4,h5,h6,pre,blockquote,br,dt,dd,figcaption";
  for (const n of root.querySelectorAll(blocks)) n.append("\n");
  const text = (root.textContent ?? "")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

// ---- Recherche -------------------------------------------------------------------------------------

function ddgUrl(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : u.href;
  } catch {
    return href;
  }
}

async function searchDuckDuckGo(query, n, fetchImpl, signal) {
  const res = await fetchImpl("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
    credentials: "omit",
  });
  if (!res.ok) throw new Error(`DuckDuckGo : HTTP ${res.status}`);
  const doc = parseHtml(await readCapped(res));
  const out = [];
  for (const r of doc.querySelectorAll(".result")) {
    if (r.classList.contains("result--ad")) continue;
    const a = r.querySelector("a.result__a");
    if (!a) continue;
    const url = ddgUrl(a.getAttribute("href") || "");
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ title: a.textContent.trim(), url, snippet: r.querySelector(".result__snippet")?.textContent.trim() ?? "" });
    if (out.length >= n) break;
  }
  if (!out.length && /anomaly|captcha|unusual traffic/i.test(doc.body?.textContent ?? "")) {
    throw new Error("DuckDuckGo demande une vérification (trop de requêtes). Réessayez plus tard ou choisissez un autre moteur.");
  }
  return out;
}

async function searchSearxng(query, n, cfg, fetchImpl, signal) {
  const base = String(cfg.webSearchUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("URL de l'instance SearXNG non configurée.");
  const headers = { Accept: "application/json" };
  if (cfg.webSearchToken) headers.Authorization = `Bearer ${cfg.webSearchToken}`;
  const res = await fetchImpl(`${base}/search?${new URLSearchParams({ q: query, format: "json" })}`, { headers, signal, credentials: "omit" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SearXNG : HTTP ${res.status}${res.status === 403 ? " (le format JSON doit être activé dans settings.yml : search.formats)" : ""}`);
  }
  const j = safeJsonParse(text);
  if (!Array.isArray(j?.results)) throw new Error("SearXNG : réponse JSON inattendue.");
  return j.results.slice(0, n).map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.content || "" }));
}

async function searchBrave(query, n, cfg, fetchImpl, signal) {
  if (!cfg.webSearchToken) throw new Error("Clé API Brave Search non configurée.");
  const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(n) })}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": cfg.webSearchToken },
    signal,
    credentials: "omit",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Brave Search : HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (vérifiez la clé API)" : ""}`);
  const j = safeJsonParse(text);
  const items = j?.web?.results;
  if (!Array.isArray(items)) return [];
  return items.slice(0, n).map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.description || "").replace(/<[^>]+>/g, "") }));
}

export function formatSearchResults(results, query) {
  if (!results.length) return `Aucun résultat web pour « ${query} ».`;
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ""}`).join("\n\n");
}

/** @returns {Promise<{title:string,url:string,snippet:string}[]>} */
export async function webSearch(cfg, query, { signal, fetchImpl = (...a) => globalThis.fetch(...a), count } = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error('Paramètre "query" manquant.');
  const n = Math.min(10, Math.max(1, parseInt(count, 10) || cfg.webMaxResults || 5));
  const t = withTimeout(20000, signal);
  try {
    if (cfg.webEngine === "searxng") return await searchSearxng(q, n, cfg, fetchImpl, t.signal);
    if (cfg.webEngine === "brave") return await searchBrave(q, n, cfg, fetchImpl, t.signal);
    return await searchDuckDuckGo(q, n, fetchImpl, t.signal);
  } catch (e) {
    if (t.timedOut) throw new Error("Délai dépassé pour la recherche web.");
    if (e instanceof TypeError) throw new Error(`Recherche web impossible${hintFor(e)}`);
    throw e;
  } finally {
    t.dispose();
  }
}

// ---- Lecture de page -------------------------------------------------------------------------------

export async function webFetch(rawUrl, { signal, fetchImpl = (...a) => globalThis.fetch(...a), maxChars = 20000 } = {}) {
  let u;
  try {
    u = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw new Error("URL invalide.");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Seules les URLs http(s) sont acceptées.");
  if (isPrivateHost(u.hostname)) throw new Error("Adresse locale ou privée : lecture refusée (protection contre l'accès au réseau interne).");
  const t = withTimeout(25000, signal);
  try {
    const res = await fetchImpl(u.href, { signal: t.signal, redirect: "follow", credentials: "omit", headers: { Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
    if (res.url) {
      let final;
      try {
        final = new URL(res.url);
      } catch {
        /* ignorer */
      }
      if (final && isPrivateHost(final.hostname)) throw new Error("Redirection vers une adresse locale ou privée : refusée.");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} pour ${u.href}`);
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (/^(image|audio|video)\//.test(type) || /pdf|zip|octet-stream|msword|officedocument/.test(type)) {
      throw new Error(`Type de contenu non pris en charge : ${type.split(";")[0]}`);
    }
    const body = await readCapped(res);
    let title = "";
    let text = body;
    if (type.includes("html") || /^\s*<(!doctype|html)/i.test(body)) ({ title, text } = htmlToText(body));
    text = truncate(text, maxChars);
    return { title, url: res.url || u.href, text };
  } catch (e) {
    if (t.timedOut) throw new Error("Délai dépassé pour la lecture de la page.");
    if (e instanceof TypeError) throw new Error(`Lecture impossible${hintFor(e)}`);
    throw e;
  } finally {
    t.dispose();
  }
}

export const formatPage = (p) => `${p.title ? `${p.title}\n` : ""}${p.url}\n\n${p.text || "(page vide)"}`;

/** Origines à autoriser pour que les outils web fonctionnent (le chat envoie les requêtes depuis la page d'extension). */
export function webOrigins(cfg) {
  if (cfg.webFetchEnabled !== false) return ["<all_urls>"];
  const e = WEB_ENGINES[cfg.webEngine] ?? WEB_ENGINES.duckduckgo;
  if (cfg.webEngine === "searxng" && cfg.webSearchUrl) {
    try {
      const u = new URL(cfg.webSearchUrl);
      return [`${u.protocol}//${u.hostname}/*`];
    } catch {
      return [];
    }
  }
  return e.origin ? [`${e.origin}/*`] : [];
}
