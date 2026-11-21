// Base RAG locale dans IndexedDB : collections -> documents -> chunks (+ embeddings optionnels).
// Recherche hybride : BM25 (toujours) + similarité vectorielle (si la collection a des embeddings),
// fusionnées par RRF.
import { uid } from "./util.js";
import { chunkText, BM25, topKByVector, rrf } from "./rag.js";

const DB_NAME = "ai-chat-rag";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("collections", { keyPath: "id" });
      const docs = db.createObjectStore("documents", { keyPath: "id" });
      docs.createIndex("collectionId", "collectionId");
      const chunks = db.createObjectStore("chunks", { keyPath: "id" });
      chunks.createIndex("collectionId", "collectionId");
      chunks.createIndex("docId", "docId");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      dbPromise = null;
      reject(r.error);
    };
  });
  return dbPromise;
}

const reqP = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function tx(stores, mode, fn) {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Transaction annulée"));
  });
  done.catch(() => {}); // évite un "unhandled rejection" si on quitte avant d'attendre `done`
  let out;
  try {
    out = await fn(t);
  } catch (e) {
    try {
      t.abort(); // pas d'écriture partielle
    } catch {
      /* déjà terminée */
    }
    throw e;
  }
  await done;
  return out;
}

// Cache mémoire des chunks + index BM25 par collection (invalidé par updatedAt).
const cache = new Map();
const invalidate = (id) => cache.delete(id);

// ---- Collections ----------------------------------------------------------------

export async function listCollections() {
  const all = await tx(["collections"], "readonly", (t) => reqP(t.objectStore("collections").getAll()));
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCollection(id) {
  return tx(["collections"], "readonly", (t) => reqP(t.objectStore("collections").get(id)));
}

/** @param {{providerId:string, model:string}|null} embedding configuration d'embeddings (null = BM25 seul) */
export async function createCollection(name, embedding = null) {
  const now = Date.now();
  const c = {
    id: uid("col_"),
    name: String(name).trim() || "Sans titre",
    createdAt: now,
    updatedAt: now,
    embedding: embedding?.providerId && embedding?.model ? { providerId: embedding.providerId, model: embedding.model, dim: 0 } : null,
    docCount: 0,
    chunkCount: 0,
  };
  await tx(["collections"], "readwrite", (t) => reqP(t.objectStore("collections").put(c)));
  return c;
}

export async function renameCollection(id, name) {
  await tx(["collections"], "readwrite", async (t) => {
    const s = t.objectStore("collections");
    const c = await reqP(s.get(id));
    if (c) {
      c.name = String(name).trim() || c.name;
      c.updatedAt = Date.now();
      await reqP(s.put(c));
    }
  });
  invalidate(id);
}

async function deleteByIndex(store, indexName, value) {
  const keys = await reqP(store.index(indexName).getAllKeys(value));
  for (const k of keys) await reqP(store.delete(k));
}

export async function deleteCollection(id) {
  await tx(["collections", "documents", "chunks"], "readwrite", async (t) => {
    await deleteByIndex(t.objectStore("chunks"), "collectionId", id);
    await deleteByIndex(t.objectStore("documents"), "collectionId", id);
    await reqP(t.objectStore("collections").delete(id));
  });
  invalidate(id);
}

// ---- Documents --------------------------------------------------------------------

export async function listDocuments(collectionId) {
  const docs = await tx(["documents"], "readonly", (t) =>
    reqP(t.objectStore("documents").index("collectionId").getAll(collectionId))
  );
  return docs.sort((a, b) => b.addedAt - a.addedAt);
}

/**
 * Ajoute un document : découpage, embeddings éventuels, écriture atomique.
 * @param {string} collectionId
 * @param {{name:string, text:string}} doc
 * @param {{chunkSize?:number, overlap?:number, embedder?:(texts:string[])=>Promise<Float32Array[]>,
 *          batchSize?:number, onProgress?:(done:number,total:number)=>void}} [opts]
 */
export async function addDocument(collectionId, doc, opts = {}) {
  const { chunkSize = 1000, overlap = 150, embedder = null, batchSize = 32, onProgress } = opts;
  const col = await getCollection(collectionId);
  if (!col) throw new Error("Collection introuvable.");
  const pieces = chunkText(doc.text, { size: chunkSize, overlap });
  if (!pieces.length) throw new Error(`« ${doc.name} » ne contient aucun texte exploitable.`);

  let vecs = null;
  if (col.embedding && embedder) {
    vecs = [];
    for (let i = 0; i < pieces.length; i += batchSize) {
      const part = await embedder(pieces.slice(i, i + batchSize));
      vecs.push(...part);
      onProgress?.(Math.min(i + batchSize, pieces.length), pieces.length);
    }
  } else {
    onProgress?.(pieces.length, pieces.length);
  }

  const docId = uid("doc_");
  const now = Date.now();
  await tx(["collections", "documents", "chunks"], "readwrite", async (t) => {
    const cs = t.objectStore("collections");
    const fresh = await reqP(cs.get(collectionId));
    if (!fresh) throw new Error("Collection supprimée pendant l'import.");
    await reqP(
      t.objectStore("documents").put({
        id: docId,
        collectionId,
        name: doc.name,
        size: doc.text.length,
        chunkCount: pieces.length,
        embedded: !!vecs,
        addedAt: now,
      })
    );
    const chunks = t.objectStore("chunks");
    for (let i = 0; i < pieces.length; i++) {
      await reqP(
        chunks.put({
          id: `${docId}:${i}`,
          collectionId,
          docId,
          docName: doc.name,
          idx: i,
          text: pieces[i],
          vec: vecs ? vecs[i] : null,
        })
      );
    }
    fresh.docCount += 1;
    fresh.chunkCount += pieces.length;
    fresh.updatedAt = now;
    if (vecs && fresh.embedding && !fresh.embedding.dim) fresh.embedding.dim = vecs[0].length;
    await reqP(cs.put(fresh));
  });
  invalidate(collectionId);
  return docId;
}

export async function deleteDocument(docId) {
  let collectionId = null;
  await tx(["collections", "documents", "chunks"], "readwrite", async (t) => {
    const docs = t.objectStore("documents");
    const d = await reqP(docs.get(docId));
    if (!d) return;
    collectionId = d.collectionId;
    await deleteByIndex(t.objectStore("chunks"), "docId", docId);
    await reqP(docs.delete(docId));
    const cs = t.objectStore("collections");
    const c = await reqP(cs.get(collectionId));
    if (c) {
      c.docCount = Math.max(0, c.docCount - 1);
      c.chunkCount = Math.max(0, c.chunkCount - d.chunkCount);
      c.updatedAt = Date.now();
      await reqP(cs.put(c));
    }
  });
  if (collectionId) invalidate(collectionId);
}

/** Recalcule les embeddings de tous les chunks avec une nouvelle configuration. */
export async function reindexEmbeddings(collectionId, embedding, embedder, { batchSize = 32, onProgress } = {}) {
  const chunks = await tx(["chunks"], "readonly", (t) =>
    reqP(t.objectStore("chunks").index("collectionId").getAll(collectionId))
  );
  const vecs = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    vecs.push(...(await embedder(chunks.slice(i, i + batchSize).map((c) => c.text))));
    onProgress?.(Math.min(i + batchSize, chunks.length), chunks.length);
  }
  await tx(["collections", "documents", "chunks"], "readwrite", async (t) => {
    const store = t.objectStore("chunks");
    for (let i = 0; i < chunks.length; i++) await reqP(store.put({ ...chunks[i], vec: vecs[i] }));
    const docs = t.objectStore("documents");
    for (const d of await reqP(docs.index("collectionId").getAll(collectionId))) {
      d.embedded = true;
      await reqP(docs.put(d));
    }
    const cs = t.objectStore("collections");
    const c = await reqP(cs.get(collectionId));
    c.embedding = { providerId: embedding.providerId, model: embedding.model, dim: vecs[0]?.length ?? 0 };
    c.updatedAt = Date.now();
    await reqP(cs.put(c));
  });
  invalidate(collectionId);
}

// ---- Recherche --------------------------------------------------------------------

async function loadIndex(col) {
  const hit = cache.get(col.id);
  if (hit && hit.stamp === col.updatedAt) return hit;
  const chunks = await tx(["chunks"], "readonly", (t) =>
    reqP(t.objectStore("chunks").index("collectionId").getAll(col.id))
  );
  const entry = {
    stamp: col.updatedAt,
    chunks,
    byId: new Map(chunks.map((c) => [c.id, c])),
    bm25: new BM25(chunks.map((c) => ({ id: c.id, text: c.text }))),
  };
  cache.set(col.id, entry);
  return entry;
}

/**
 * Recherche hybride dans une ou plusieurs collections.
 * @param {{collectionIds:string[], query:string, topK?:number,
 *          getEmbedder?:(cfg:{providerId:string,model:string})=>Promise<((texts:string[])=>Promise<Float32Array[]>)|null>}} p
 * @returns {Promise<{results:Array, warnings:string[]}>}
 */
export async function search({ collectionIds, query, topK = 5, getEmbedder }) {
  const warnings = [];
  const merged = [];
  for (const id of collectionIds) {
    const col = await getCollection(id);
    if (!col || !col.chunkCount) continue;
    const idx = await loadIndex(col);
    const lists = [idx.bm25.search(query, topK * 4)];
    let mode = "bm25";
    if (col.embedding && getEmbedder) {
      try {
        const embedder = await getEmbedder(col.embedding);
        if (!embedder) throw new Error("fournisseur d'embeddings introuvable");
        const [qvec] = await embedder([query]);
        lists.push(topKByVector(qvec, idx.chunks.map((c) => ({ id: c.id, vec: c.vec })), topK * 4));
        mode = "hybride";
      } catch (e) {
        warnings.push(`Embeddings indisponibles pour « ${col.name} » (${e.message}) : recherche lexicale uniquement.`);
      }
    }
    const fused = lists.length > 1 ? rrf(lists) : lists[0];
    // Les scores BM25 et RRF ne sont pas comparables entre collections : on classe par score relatif
    // (1 = meilleur résultat de la collection), ce qui revient à entrelacer les collections.
    const top = fused[0]?.score || 1;
    for (const f of fused.slice(0, topK)) {
      const c = idx.byId.get(f.id);
      if (c) {
        merged.push({
          collectionId: col.id,
          collectionName: col.name,
          docName: c.docName,
          idx: c.idx,
          text: c.text,
          score: f.score / top,
          rawScore: f.score,
          mode,
        });
      }
    }
  }
  merged.sort((a, b) => b.score - a.score);
  return { results: merged.slice(0, topK), warnings };
}
