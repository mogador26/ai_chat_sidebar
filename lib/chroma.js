// Import de données ChromaDB dans une collection RAG :
//  - export JSON (collection.get() / query(), liste d'objets, JSON Lines) ;
//  - base persistante `chroma.sqlite3` (lecture directe du format de fichier SQLite, sans WebAssembly).
// Seuls les textes et métadonnées sont repris : les vecteurs de Chroma ne sont jamais réutilisés, car les requêtes
// doivent être encodées par le même modèle que les extraits (ceux de la collection RAG, indexés à l'import).

const SQLITE_MAGIC = "SQLite format 3\u0000";
const DOC_KEY = "chroma:document";

export class ChromaFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChromaFormatError";
  }
}

/** Le contenu commence-t-il par l'en-tête d'un fichier SQLite ? */
export function isSqliteBuffer(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length < 100) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i++) if (u[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

// ---- Export JSON -----------------------------------------------------------------------------------

const textOf = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function recordsFromColumns(o) {
  // { ids, documents, metadatas } : tableaux parallèles (get) ou tableaux de tableaux (query)
  let docs = o.documents;
  if (!Array.isArray(docs)) return null;
  const nested = docs.length > 0 && docs.every((d) => Array.isArray(d));
  const flat = (a) => (Array.isArray(a) ? (nested ? a.flat() : a) : []);
  docs = flat(docs);
  const ids = flat(o.ids);
  const metas = flat(o.metadatas);
  return docs.map((d, i) => ({ id: ids[i] != null ? String(ids[i]) : String(i), text: textOf(d), metadata: isObj(metas[i]) ? metas[i] : {} }));
}

function recordsFromRows(rows) {
  const out = [];
  for (const [i, r] of rows.entries()) {
    if (!isObj(r)) return null;
    const text = r.document ?? r.documents ?? r.text ?? r.content ?? r.page_content;
    if (typeof text !== "string") return null;
    out.push({ id: r.id != null ? String(r.id) : String(i), text, metadata: isObj(r.metadata) ? r.metadata : isObj(r.metadatas) ? r.metadatas : {}, collection: r.collection });
  }
  return out;
}

/**
 * Reconnaît un export Chroma dans un texte JSON ou JSON Lines.
 * @returns {{ collections: {name:string, records:{id:string,text:string,metadata:object}[]}[] } | null}
 *          null si le contenu n'a pas la forme d'un export Chroma (il sera alors importé comme texte brut).
 */
export function parseChromaJson(text) {
  const src = String(text ?? "").trim();
  if (!src || (src[0] !== "{" && src[0] !== "[")) return null;
  let data;
  try {
    data = JSON.parse(src);
  } catch {
    // JSON Lines : un objet par ligne
    const lines = src.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 1 || lines[0][0] !== "{") return null;
    try {
      data = lines.map((l) => JSON.parse(l));
    } catch {
      return null;
    }
  }
  let recs = null;
  let name = "";
  if (Array.isArray(data)) recs = recordsFromRows(data);
  else if (isObj(data)) {
    name = typeof data.collection === "string" ? data.collection : typeof data.name === "string" ? data.name : "";
    recs = recordsFromColumns(data) ?? (Array.isArray(data.records) ? recordsFromRows(data.records) : Array.isArray(data.items) ? recordsFromRows(data.items) : null);
    if (!recs && isObj(data.collection) && Array.isArray(data.collection.documents)) recs = recordsFromColumns(data.collection);
  }
  if (!recs?.length) return null;
  // Un JSON de lignes isolées ({text:…}) sans aucun champ Chroma n'en est pas un : exiger un id ou "document(s)"
  const looksChroma =
    isObj(data) ? "documents" in data || "records" in data : data.some((r) => isObj(r) && ("document" in r || "documents" in r || ("id" in r && "metadata" in r)));
  if (!looksChroma) return null;
  const byCol = new Map();
  for (const r of recs) {
    const c = typeof r.collection === "string" && r.collection ? r.collection : name;
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c).push({ id: r.id, text: r.text, metadata: r.metadata });
  }
  return { collections: [...byCol].map(([n, records]) => ({ name: n, records })) };
}

// ---- Lecture d'un fichier SQLite -------------------------------------------------------------------

class SqliteReader {
  constructor(buf) {
    this.u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(this.u.buffer, this.u.byteOffset, this.u.byteLength);
    if (!isSqliteBuffer(this.u)) throw new ChromaFormatError("Ce fichier n'est pas une base SQLite.");
    const ps = this.dv.getUint16(16);
    this.pageSize = ps === 1 ? 65536 : ps;
    this.usable = this.pageSize - this.u[20];
    const enc = this.dv.getUint32(56);
    if (enc > 1) throw new ChromaFormatError("Base SQLite en UTF-16 : non prise en charge.");
    this.pageCount = Math.floor(this.u.length / this.pageSize);
    this.dec = new TextDecoder("utf-8");
    if (this.u[18] === 2 || this.u[19] === 2) this.wal = true; // mode WAL : les écritures non « checkpointées » sont dans le fichier -wal
  }

  varint(pos) {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const b = this.u[pos + i];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return [v, i + 1];
    }
    return [v * 256 + this.u[pos + 8], 9];
  }

  /** Charge la charge utile (avec pages de débordement) d'une cellule de feuille de table. */
  payload(pos, total) {
    const U = this.usable;
    const X = U - 35;
    if (total <= X) return this.u.subarray(pos, pos + total);
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((total - M) % (U - 4));
    const local = K <= X ? K : M;
    const out = new Uint8Array(total);
    out.set(this.u.subarray(pos, pos + local), 0);
    let got = local;
    let next = this.dv.getUint32(pos + local);
    const seen = new Set();
    while (got < total && next) {
      if (next > this.pageCount || seen.has(next)) throw new ChromaFormatError("Base SQLite corrompue (pages de débordement).");
      seen.add(next);
      const base = (next - 1) * this.pageSize;
      const take = Math.min(total - got, U - 4);
      out.set(this.u.subarray(base + 4, base + 4 + take), got);
      got += take;
      next = this.dv.getUint32(base);
    }
    if (got < total) throw new ChromaFormatError("Base SQLite tronquée.");
    return out;
  }

  record(bytes) {
    const [hdrSize, n0] = this.varint0(bytes, 0);
    const types = [];
    let p = n0;
    while (p < hdrSize) {
      const [t, n] = this.varint0(bytes, p);
      types.push(t);
      p += n;
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const row = [];
    let q = hdrSize;
    for (const t of types) {
      if (t === 0) row.push(null);
      else if (t >= 1 && t <= 6) {
        const size = [0, 1, 2, 3, 4, 6, 8][t];
        let v = 0n;
        for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(bytes[q + i]);
        if (bytes[q] & 0x80) v -= 1n << BigInt(size * 8);
        row.push(Number(v));
        q += size;
      } else if (t === 7) {
        row.push(dv.getFloat64(q));
        q += 8;
      } else if (t === 8) row.push(0);
      else if (t === 9) row.push(1);
      else if (t >= 12) {
        const len = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
        const slice = bytes.subarray(q, q + len);
        row.push(t % 2 === 0 ? slice : this.dec.decode(slice));
        q += len;
      } else throw new ChromaFormatError("Base SQLite : type de valeur inconnu.");
    }
    return row;
  }

  varint0(bytes, pos) {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const b = bytes[pos + i];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return [v, i + 1];
    }
    return [v * 256 + bytes[pos + 8], 9];
  }

  /** Parcourt la B-arbre d'une table : appelle onRow(rowid, valeurs) dans l'ordre des rowid. */
  scanTable(root, onRow) {
    const seen = new Set();
    const walk = (pageNo, depth) => {
      if (depth > 40 || pageNo < 1 || pageNo > this.pageCount || seen.has(pageNo)) throw new ChromaFormatError("Base SQLite corrompue (arbre de table).");
      seen.add(pageNo);
      const base = (pageNo - 1) * this.pageSize;
      const h = base + (pageNo === 1 ? 100 : 0);
      const type = this.u[h];
      const cells = this.dv.getUint16(h + 3);
      if (type === 0x0d) {
        for (let i = 0; i < cells; i++) {
          let pos = base + this.dv.getUint16(h + 8 + i * 2);
          const [size, a] = this.varint(pos);
          pos += a;
          const [rowid, b] = this.varint(pos);
          pos += b;
          onRow(rowid, this.record(this.payload(pos, size)));
        }
      } else if (type === 0x05) {
        for (let i = 0; i < cells; i++) walk(this.dv.getUint32(base + this.dv.getUint16(h + 12 + i * 2)), depth + 1);
        walk(this.dv.getUint32(h + 8), depth + 1);
      } else throw new ChromaFormatError("Base SQLite : page inattendue (index ou format non pris en charge).");
    };
    walk(root, 0);
  }

  /** Tables du schéma : { nom: { root, columns[], ipk } } (ipk = indice de la colonne INTEGER PRIMARY KEY). */
  tables() {
    const out = {};
    this.scanTable(1, (rowid, r) => {
      if (r[0] !== "table" || typeof r[4] !== "string" || !r[3]) return;
      out[r[1]] = { root: r[3], ...parseCreate(r[4]) };
    });
    return out;
  }

  rows(table) {
    const rows = [];
    this.scanTable(table.root, (rowid, vals) => {
      const o = {};
      table.columns.forEach((c, i) => (o[c] = i === table.ipk ? rowid : vals[i] ?? null));
      rows.push(o);
    });
    return rows;
  }
}

/** Extrait les noms de colonnes d'un CREATE TABLE (suffisant pour les tables de Chroma). */
function parseCreate(sql) {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) return { columns: [], ipk: -1 };
  const body = sql.slice(open + 1, close).replace(/--[^\n]*/g, ""); // commentaires de fin de ligne
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const columns = [];
  let ipk = -1;
  for (const part of parts) {
    const def = part.trim();
    if (/^(primary\s+key|unique|foreign\s+key|check|constraint)\b/i.test(def)) continue;
    const m = def.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\S+))\s*(.*)$/s);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (/^integer\b.*\bprimary\s+key\b/i.test(m[5]) && !/\bdesc\b/i.test(m[5])) ipk = columns.length;
    columns.push(name);
  }
  return { columns, ipk };
}

const metaValue = (r) => r.string_value ?? r.int_value ?? r.float_value ?? (r.bool_value != null ? !!r.bool_value : null);

/**
 * Lit les textes et métadonnées d'une base Chroma (≥ 0.4).
 * @returns {{ collections: {name:string, records:{id:string,text:string,metadata:object}[]}[], warnings: string[] }}
 */
export function readChromaSqlite(buf) {
  const rd = new SqliteReader(buf);
  const t = rd.tables();
  if (!t.embeddings || !t.embedding_metadata) {
    throw new ChromaFormatError("Cette base SQLite n'a pas les tables de Chroma (embeddings, embedding_metadata) : version non prise en charge ?");
  }
  const warnings = [];
  const segToCol = new Map();
  const colNames = new Map();
  if (t.collections) for (const c of rd.rows(t.collections)) colNames.set(c.id, c.name);
  if (t.segments) for (const s of rd.rows(t.segments)) segToCol.set(s.id, colNames.get(s.collection) ?? String(s.collection));

  const meta = new Map(); // id interne -> métadonnées
  for (const r of rd.rows(t.embedding_metadata)) {
    let m = meta.get(r.id);
    if (!m) meta.set(r.id, (m = {}));
    m[r.key] = metaValue(r);
  }
  const byCol = new Map();
  let empty = 0;
  for (const e of rd.rows(t.embeddings).sort((a, b) => a.id - b.id)) {
    const m = meta.get(e.id) ?? {};
    const text = m[DOC_KEY];
    if (typeof text !== "string" || !text.trim()) {
      empty++;
      continue;
    }
    const metadata = {};
    for (const [k, v] of Object.entries(m)) if (!k.startsWith("chroma:")) metadata[k] = v;
    const name = segToCol.get(e.segment_id) ?? "";
    if (!byCol.has(name)) byCol.set(name, []);
    byCol.get(name).push({ id: String(e.embedding_id ?? e.id), text, metadata });
  }
  if (empty) warnings.push(`${empty} enregistrement(s) sans texte ignoré(s).`);
  if (rd.wal) warnings.push("Base en mode WAL : si des données récentes manquent, fermez Chroma (checkpoint) avant l'import.");
  if (!byCol.size) throw new ChromaFormatError("Aucun document trouvé dans cette base Chroma (les textes sont-ils stockés ?).");
  return { collections: [...byCol].map(([name, records]) => ({ name, records })), warnings };
}

// ---- Regroupement en documents ---------------------------------------------------------------------

const SOURCE_KEYS = ["source", "file_path", "filepath", "path", "filename", "file_name", "file", "url", "uri", "title", "document_name"];
const ORDER_KEYS = ["chunk_index", "chunk", "chunk_id", "chunk_number", "start_index", "offset", "page", "page_number"];

const baseName = (s) => String(s).replace(/[?#].*$/, "").split(/[\\/]/).filter(Boolean).pop() || String(s);

/**
 * Regroupe les enregistrements d'une collection Chroma en documents, un par source (métadonnée `source`,
 * `file_path`, `url`…), triés par numéro de morceau si connu. Sans source : un seul document.
 * @returns {{name:string, text:string, records:number}[]}
 */
export function chromaToDocuments(collection, { fallbackName = "chroma", prefix = "" } = {}) {
  const groups = new Map();
  for (const r of collection.records) {
    const key = SOURCE_KEYS.map((k) => r.metadata?.[k]).find((v) => typeof v === "string" && v.trim()) ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const base = collection.name || fallbackName;
  const out = [];
  for (const [key, recs] of groups) {
    const ordKey = ORDER_KEYS.find((k) => recs.every((r) => typeof r.metadata?.[k] === "number"));
    const ordered = ordKey ? [...recs].sort((a, b) => a.metadata[ordKey] - b.metadata[ordKey]) : recs;
    const label = key ? baseName(key) : base;
    out.push({
      name: `${prefix}${key && collection.name ? `${collection.name} › ` : ""}${label}`,
      text: ordered.map((r) => r.text.trim()).filter(Boolean).join("\n\n"),
      records: recs.length,
    });
  }
  // Noms uniques (deux sources de même nom de fichier)
  const used = new Map();
  for (const d of out) {
    const n = used.get(d.name) ?? 0;
    used.set(d.name, n + 1);
    if (n) d.name = `${d.name} (${n + 1})`;
  }
  return out.filter((d) => d.text);
}
