// Aides DOM partagées par la barre latérale et la page d'options.
// Aucune insertion de HTML : tout passe par createElement / textContent.

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  plus: "M12 5v14M5 12h14",
  history: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  settings: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z",
  stop: "M6 6h12v12H6z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6",
  copy: "M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  check: "M20 6L9 17l-5-5",
  chevron: "M9 18l6-6-6-6",
  x: "M18 6L6 18M6 6l12 12",
  refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z",
  database:
    "M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3zM3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6",
};

/** Icône SVG (trait, couleur courante). */
export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "icon",
  })) {
    svg.setAttribute(k, String(v));
  }
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.x);
  svg.append(p);
  return svg;
}

const ATTR_ONLY = new Set(["style", "list", "form", "for", "role"]);

/**
 * Crée un élément. props : class, dataset, onclick/oninput/…(fonction), text, ou propriété/attribut.
 * Les enfants texte sont ajoutés comme nœuds texte (jamais interprétés comme du HTML).
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (!ATTR_ONLY.has(k) && k in node) node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Remplace le contenu des éléments portant data-icon="nom" par l'icône correspondante. */
export function hydrateIcons(root = document) {
  for (const n of root.querySelectorAll("[data-icon]")) {
    n.prepend(icon(n.dataset.icon, Number(n.dataset.iconSize) || 16));
    n.removeAttribute("data-icon");
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
