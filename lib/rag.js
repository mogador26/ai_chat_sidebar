// RAG — fonctions pures : découpage en chunks, BM25 (lexical), similarité cosinus, fusion RRF.

const STOPWORDS = new Set(
  (
    "le la les un une des du de d l et ou en au aux a à est sont été être ce ces cet cette son sa ses sur dans par pour avec sans " +
    "que qui quoi dont où ne pas plus se je tu il elle on nous vous ils elles mon ma mes ton ta tes leur leurs y " +
    "the a an and or of to in on at by for with without is are was were be been this that these those it its as from " +
    "not no i you he she we they my your his her our their"
  ).split(/\s+/)
);

/** Minuscules, sans accents, mots alphanumériques, sans mots vides, pluriel simplifié. */
export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

function hardSplit(s, size) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      const ws = s.lastIndexOf(" ", end);
      if (ws > i + size * 0.6) end = ws;
    }
    const piece = s.slice(i, end).trim();
    if (piece) out.push(piece);
    i = end;
    while (i < s.length && /\s/.test(s[i])) i++;
  }
  return out;
}

/**
 * Découpe un texte en chunks d'environ `size` caractères, en respectant paragraphes et phrases,
 * avec un recouvrement d'environ `overlap` caractères entre chunks consécutifs.
 */
export function chunkText(text, { size = 1000, overlap = 150 } = {}) {
  size = Math.max(100, size | 0);
  overlap = Math.max(0, Math.min(overlap | 0, Math.floor(size / 2)));
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];

  const units = []; // { sep, text }
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) {
      units.push({ sep: "\n\n", text: p });
      continue;
    }
    let first = true;
    for (const sentence of p.split(/(?<=[.!?…])\s+|\n/)) {
      const s = sentence.trim();
      if (!s) continue;
      const pieces = s.length > size ? hardSplit(s, size) : [s];
      for (const piece of pieces) {
        units.push({ sep: first ? "\n\n" : " ", text: piece });
        first = false;
      }
    }
  }

  const lenOf = (u) => u.sep.length + u.text.length;
  const render = (list) => list.map((u, i) => (i ? u.sep : "") + u.text).join("");
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const u of units) {
    if (cur.length && curLen + lenOf(u) > size) {
      chunks.push(render(cur));
      const keep = [];
      let keepLen = 0;
      for (let i = cur.length - 1; i >= 1; i--) {
        if (keepLen + lenOf(cur[i]) > overlap) break;
        keep.unshift(cur[i]);
        keepLen += lenOf(cur[i]);
      }
      cur = keep;
      curLen = keepLen;
    }
    cur.push(u);
    curLen += lenOf(u);
  }
  if (cur.length) chunks.push(render(cur));
  return chunks;
}

/** Index BM25 sur [{ id, text }]. */
export class BM25 {
  constructor(docs, { k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.ids = [];
    this.lens = [];
    this.postings = new Map(); // terme -> [[docIdx, tf], ...]
    let total = 0;
    docs.forEach((d, idx) => {
      const tokens = tokenize(d.text);
      this.ids.push(d.id);
      this.lens.push(tokens.length);
      total += tokens.length;
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        let list = this.postings.get(t);
        if (!list) this.postings.set(t, (list = []));
        list.push([idx, n]);
      }
    });
    this.N = docs.length;
    this.avg = this.N ? total / this.N : 0;
  }

  /** @returns {{id:any, score:number}[]} trié par score décroissant (score > 0 uniquement) */
  search(query, k = 5) {
    const scores = new Map();
    for (const t of new Set(tokenize(query))) {
      const list = this.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (this.N - list.length + 0.5) / (list.length + 0.5));
      for (const [idx, tf] of list) {
        const norm = 1 - this.b + this.b * (this.lens[idx] / (this.avg || 1));
        const s = idf * ((tf * (this.k1 + 1)) / (tf + this.k1 * norm));
        scores.set(idx, (scores.get(idx) ?? 0) + s);
      }
    }
    return [...scores]
      .map(([idx, score]) => ({ id: this.ids[idx], score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

export function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Top-k par produit scalaire (vecteurs déjà normalisés => cosinus). items: [{ id, vec }] */
export function topKByVector(qvec, items, k = 5) {
  const out = [];
  for (const it of items) {
    if (!it.vec || it.vec.length !== qvec.length) continue;
    out.push({ id: it.id, score: dot(qvec, it.vec) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Reciprocal Rank Fusion de plusieurs classements [{id}, ...]. */
export function rrf(lists, { k = 60 } = {}) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((item, rank) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}
