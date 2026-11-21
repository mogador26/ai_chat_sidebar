// Utilitaires partagés (sans dépendance au DOM ni à l'API browser).

export function uid(prefix = "") {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function trimSlash(s) {
  return String(s || "").trim().replace(/\/+$/, "");
}

/** Motif de permission d'hôte pour une URL. Firefox ignore les ports dans les match patterns. */
export function originPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

export function isLocalHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/** true si l'URL enverrait des secrets en clair sur un réseau non local. */
export function isInsecureRemote(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/** Normalise un vecteur (norme L2 = 1) : le produit scalaire devient alors la similarité cosinus. */
export function normalizeVec(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function slug(s, max = 32) {
  const out = String(s || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (out || "x").slice(0, max);
}

export function truncate(s, n, note = "\n[… tronqué]") {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + note : s;
}

export function safeJsonParse(s, fallback = undefined) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** "Clé: valeur" par ligne -> objet. Ignore lignes vides, commentaires (#) et noms invalides. */
export function parseHeaderLines(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 1) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
    out[name] = value;
  }
  return out;
}

export function headersToText(obj) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

/** Combine plusieurs AbortSignal en un seul. */
export function combineSignals(...signals) {
  const ctrl = new AbortController();
  const list = signals.filter(Boolean);
  const onAbort = (e) => ctrl.abort(e?.target?.reason);
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose() {
      for (const s of list) s.removeEventListener("abort", onAbort);
    },
  };
}

/** Signal avec délai maximum, combiné à un signal parent optionnel. */
export function withTimeout(ms, parent) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new Error(`Délai dépassé (${Math.round(ms / 1000)} s)`));
  }, ms);
  const combo = combineSignals(ctrl.signal, parent);
  return {
    signal: combo.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      combo.dispose();
    },
  };
}

export function isAbortError(e) {
  return !!e && (e.name === "AbortError" || e.code === 20);
}

/** Sépare un éventuel bloc <think>…</think> (modèles de raisonnement locaux) du texte visible. */
export function splitThink(content) {
  const s = String(content ?? "");
  const m = /^\s*<think>([\s\S]*?)(<\/think>|$)/.exec(s);
  if (!m) return { reasoning: "", text: s };
  return { reasoning: m[1].trim(), text: s.slice(m[0].length).replace(/^\s+/, "") };
}
