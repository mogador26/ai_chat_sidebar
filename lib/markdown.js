// Rendu Markdown sûr : construit des nœuds DOM avec createElement/textContent, sans jamais passer par innerHTML.
// Le contenu produit par un modèle (ou renvoyé par un outil) est donc incapable d'injecter du HTML ou du script.
// Liens : http(s) et mailto uniquement. Images distantes : jamais chargées (affichées comme liens).

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (l) => l.length - l.trimStart().length;
const h = (doc, tag, cls) => {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

function isBlockStart(l) {
  return FENCE_OPEN.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l);
}

export function renderMarkdown(src, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  renderBlocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"), frag, doc);
  return frag;
}

function renderBlocks(lines, parent, doc) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    let m = FENCE_OPEN.exec(line);
    if (m) {
      const fence = m[1];
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++; // fence fermante (absente tant que le flux n'est pas terminé)
      parent.append(codeBlock(body.join("\n"), m[2], doc));
      continue;
    }

    m = HEADING.exec(line);
    if (m) {
      const hd = h(doc, "h" + m[1].length);
      renderInline(m[2], hd, doc);
      parent.append(hd);
      i++;
      continue;
    }

    if (HR.test(line)) {
      parent.append(h(doc, "hr"));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const q = [];
      while (i < lines.length && QUOTE.test(lines[i])) q.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      const bq = h(doc, "blockquote");
      renderBlocks(q, bq, doc);
      parent.append(bq);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && TABLE_SEP.test(lines[i + 1])) {
      i = renderTable(lines, i, parent, doc);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      i = renderList(lines, i, parent, doc);
      continue;
    }

    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isBlockStart(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    const p = h(doc, "p");
    renderInline(para.join("\n"), p, doc);
    parent.append(p);
  }
}

function codeBlock(text, lang, doc) {
  const wrap = h(doc, "div", "codeblock");
  const head = h(doc, "div", "code-head");
  const label = h(doc, "span", "code-lang");
  label.textContent = lang || "code";
  const btn = h(doc, "button", "copy-btn");
  btn.type = "button";
  btn.textContent = "Copier";
  head.append(label, btn);
  const pre = h(doc, "pre");
  const code = h(doc, "code");
  code.textContent = text;
  pre.append(code);
  wrap.append(head, pre);
  return wrap;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function renderTable(lines, i, parent, doc) {
  const head = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) =>
    /^:-+:$/.test(c) ? "center" : /^-+:$/.test(c) ? "right" : /^:-+$/.test(c) ? "left" : ""
  );
  i += 2;
  const table = h(doc, "table");
  const thead = h(doc, "thead");
  const tr = h(doc, "tr");
  head.forEach((c, k) => {
    const th = h(doc, "th");
    if (aligns[k]) th.style.textAlign = aligns[k];
    renderInline(c, th, doc);
    tr.append(th);
  });
  thead.append(tr);
  table.append(thead);
  const tbody = h(doc, "tbody");
  while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !isBlockStart(lines[i])) {
    const cells = splitRow(lines[i++]);
    const row = h(doc, "tr");
    for (let k = 0; k < head.length; k++) {
      const td = h(doc, "td");
      if (aligns[k]) td.style.textAlign = aligns[k];
      renderInline(cells[k] ?? "", td, doc);
      row.append(td);
    }
    tbody.append(row);
  }
  table.append(tbody);
  const wrap = h(doc, "div", "table-wrap");
  wrap.append(table);
  parent.append(wrap);
  return i;
}

function renderList(lines, i, parent, doc) {
  const first = LIST_ITEM.exec(lines[i]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = h(doc, ordered ? "ol" : "ul");
  if (ordered) {
    const n = parseInt(first[2], 10);
    if (n !== 1) list.start = n;
  }
  while (i < lines.length) {
    const mm = LIST_ITEM.exec(lines[i]);
    if (!mm || mm[1].length > baseIndent + 1 || /\d/.test(mm[2]) !== ordered) break;
    const contentIndent = mm[1].length + mm[2].length + 1;
    const itemLines = [mm[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > baseIndent + 1) {
          itemLines.push("");
          i++;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind > baseIndent + 1) {
        itemLines.push(l.slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      if (LIST_ITEM.test(l) || isBlockStart(l)) break;
      itemLines.push(l.trim()); // continuation "paresseuse"
      i++;
    }
    const li = h(doc, "li");
    if (itemLines.length === 1) renderInline(itemLines[0], li, doc);
    else renderBlocks(itemLines, li, doc);
    list.append(li);
  }
  parent.append(list);
  return i;
}

// ---- Inline ----------------------------------------------------------------------------------

const RULES = [
  { name: "code", re: /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g },
  { name: "link", re: /(!?)\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\s*\)/g },
  { name: "bold", re: /\*\*(?=\S)([\s\S]*?\S)\*\*|(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g },
  { name: "strike", re: /~~(?=\S)([\s\S]*?\S)~~/g },
  { name: "italic", re: /\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)|(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g },
  { name: "autolink", re: /https?:\/\/[^\s<>"'`]+/g },
  { name: "br", re: /\n/g },
];

function safeHref(href) {
  try {
    const u = new URL(href);
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function makeLink(doc, href, label, inLink) {
  const a = h(doc, "a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  a.title = href; // la destination réelle reste visible au survol
  if (typeof label === "string") a.textContent = label;
  else a.append(label);
  return a;
}

export function renderInline(text, parent, doc, inLink = false) {
  let pos = 0;
  const flushText = (end) => {
    if (end > pos) parent.append(doc.createTextNode(text.slice(pos, end)));
  };
  while (pos < text.length) {
    let best = null;
    for (const rule of RULES) {
      if (inLink && rule.name === "autolink") continue;
      rule.re.lastIndex = pos;
      const m = rule.re.exec(text);
      if (m && (!best || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) break;
    const { rule, m } = best;
    flushText(m.index);
    pos = m.index + m[0].length;

    switch (rule.name) {
      case "code": {
        const c = h(doc, "code");
        c.textContent = m[2].replace(/^ (.*) $/s, "$1");
        parent.append(c);
        break;
      }
      case "link": {
        const isImage = m[1] === "!";
        const href = safeHref(m[3]);
        const label = m[2] || m[3];
        if (!href) {
          parent.append(doc.createTextNode(`${isImage ? "[image : " : ""}${label}${isImage ? "]" : ""} (${m[3]})`));
        } else if (isImage) {
          parent.append(makeLink(doc, href, `[image : ${m[2] || href}]`, true));
        } else {
          const a = makeLink(doc, href, "", true);
          renderInline(label, a, doc, true);
          parent.append(a);
        }
        break;
      }
      case "bold":
      case "strike":
      case "italic": {
        const tag = rule.name === "bold" ? "strong" : rule.name === "strike" ? "del" : "em";
        const n = h(doc, tag);
        renderInline(m[1] ?? m[2], n, doc, inLink);
        parent.append(n);
        break;
      }
      case "autolink": {
        let url = m[0];
        const trail = /[.,;:!?'")\]]+$/.exec(url);
        if (trail) {
          url = url.slice(0, url.length - trail[0].length);
          pos -= trail[0].length;
        }
        const href = safeHref(url);
        if (href) parent.append(makeLink(doc, href, url, false));
        else parent.append(doc.createTextNode(url));
        break;
      }
      case "br":
        parent.append(h(doc, "br"));
        break;
    }
  }
  flushText(text.length);
}
