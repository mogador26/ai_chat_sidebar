// Page de paramètres : fournisseurs IA (URL + token), serveurs MCP, RAG, réglages généraux.
import { el, clear } from "../lib/dom.js";
import * as store from "../lib/storage.js";
import { listModelsDetailed, embed, describeError, kindOf, chatModels, embeddingModels } from "../lib/llm.js";
import { McpClient } from "../lib/mcp.js";
import { ToolRegistry } from "../lib/tools.js";
import * as ragdb from "../lib/ragdb.js";
import { createServices } from "../lib/services.js";
import { isSqliteBuffer, readChromaSqlite, parseChromaJson, chromaToDocuments } from "../lib/chroma.js";
import { webSearch, WEB_ENGINES, webOrigins } from "../lib/web.js";
import { originPattern, isInsecureRemote, parseHeaderLines, headersToText, withTimeout } from "../lib/util.js";

const api = globalThis.browser ?? globalThis.chrome;

// ---- Aides --------------------------------------------------------------------------------------------

const PRESETS = [
  { id: "openai", label: "OpenAI", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "mistral", label: "Mistral AI", name: "Mistral", type: "openai", baseUrl: "https://api.mistral.ai/v1" },
  { id: "groq", label: "Groq", name: "Groq", type: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "openrouter", label: "OpenRouter", name: "OpenRouter", type: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "gemini", label: "Google Gemini (API compatible OpenAI)", name: "Gemini", type: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "ollama", label: "Ollama (local)", name: "Ollama", type: "openai", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio (local)", name: "LM Studio", type: "openai", baseUrl: "http://localhost:1234/v1" },
];

/** À appeler SYNCHRONIQUEMENT depuis un gestionnaire de clic (Firefox exige un geste utilisateur). */
function requestHost(url) {
  if (!api?.permissions?.request) return Promise.resolve(true);
  try {
    return Promise.resolve(api.permissions.request({ origins: [originPattern(url)] })).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}
async function hasHost(url) {
  if (!api?.permissions?.contains) return true;
  try {
    return await api.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    return false;
  }
}

function checkUrl(value) {
  const s = String(value || "").trim();
  if (!s) return { error: "L'URL est obligatoire." };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { error: "URL invalide (exemple : https://api.exemple.com/v1)." };
  }
  if (!["http:", "https:"].includes(u.protocol)) return { error: "Seules les URLs http(s) sont acceptées." };
  return { url: s };
}
function checkSecret(value) {
  const s = String(value || "").trim();
  if (/[\r\n\0]/.test(s)) return { error: "Le token contient un retour à la ligne ou un caractère invalide." };
  return { token: s };
}
function checkHeaders(text) {
  const headers = parseHeaderLines(text);
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length !== Object.keys(headers).length) return { error: "En-têtes : une ligne n'est pas au format « Nom: valeur »." };
  return { headers };
}

const field = (label, input, hint, cls = "") =>
  el("label", { class: `field ${cls}` }, el("span", { class: "label" }, label), input, hint ? el("span", { class: "hint" }, hint) : null);

function secretInput(value, placeholder = "") {
  const input = el("input", { type: "password", value: value || "", placeholder, autocomplete: "new-password", spellcheck: false });
  const btn = el(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: () => {
        input.type = input.type === "password" ? "text" : "password";
        btn.textContent = input.type === "password" ? "Afficher" : "Masquer";
      },
    },
    "Afficher"
  );
  return { input, row: el("div", { class: "secret" }, input, btn) };
}

function flashBox() {
  const n = el("div", { class: "flash", hidden: true, role: "status" });
  n.set = (text, kind = "ok") => {
    n.className = `flash ${kind}`;
    n.textContent = text;
    n.hidden = !text;
  };
  return n;
}

const check = (label, checked) => {
  const input = el("input", { type: "checkbox", checked: !!checked });
  return { input, row: el("label", { class: "check" }, input, el("span", {}, label)) };
};

const confirmButton = (label, confirmLabel, onConfirm, cls = "btn danger small") => {
  const b = el("button", { class: cls, type: "button" }, label);
  let armed = false;
  b.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      setTimeout(() => {
        armed = false;
        b.textContent = label;
      }, 4000);
      return;
    }
    onConfirm();
  });
  return b;
};

function listWithForm({ items, addLabel, newItem, renderCard, buildForm, empty }) {
  const cards = el("div", { class: "cards" });
  const host = el("div");
  const close = () => clear(host);
  const open = (item, isNew) => {
    clear(host).append(buildForm(structuredClone(item), isNew, close));
    host.scrollIntoView?.({ block: "nearest" });
  };
  if (!items.length && empty) cards.append(el("p", { class: "muted" }, empty));
  for (const it of items) cards.append(renderCard(it, () => open(it, false)));
  return el("div", {}, cards, el("div", { class: "row" }, el("button", { class: "btn primary", type: "button", onclick: () => open(newItem(), true) }, addLabel)), host);
}

// ---- Application -----------------------------------------------------------------------------------------

export async function init() {
  const root = document.getElementById("app");
  const tabs = document.getElementById("tabs");
  const services = createServices();
  let current = "providers";
  let selectedCollection = null;
  let notice = null; // message affiché en haut de l'onglet après une action

  const rerender = () => show(current);
  const setNotice = (text, kind = "ok") => (notice = text ? { text, kind } : null);

  async function show(tab) {
    current = tab;
    for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
    const view = el("div");
    clear(root).append(view);
    await RENDER[tab](view);
    if (notice) {
      const f = flashBox();
      f.set(notice.text, notice.kind);
      view.prepend(f);
      notice = null;
    }
  }
  tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) show(b.dataset.tab);
  });

  // ======================= Fournisseurs IA =======================

  async function renderProviders(view) {
    const cfg = await store.loadConfig();
    view.append(
      el("h2", {}, "Fournisseurs IA"),
      el("p", { class: "lead" }, "Renseignez l'URL de l'API et le token de chaque fournisseur. Vos messages ne sont envoyés qu'aux URLs configurées ici."),
      listWithForm({
        items: cfg.providers,
        addLabel: "+ Ajouter un fournisseur",
        empty: "Aucun fournisseur. Ajoutez-en un pour commencer à discuter.",
        newItem: () => store.newProvider(),
        renderCard: (p, edit) => providerCard(p, cfg, edit),
        buildForm: (draft, isNew, close) => providerForm(draft, isNew, cfg, close),
      })
    );
  }

  function providerCard(p, cfg, edit) {
    const access = el("span", { class: "badge" }, "accès : …");
    hasHost(p.baseUrl).then((ok) => {
      access.className = `badge ${ok ? "ok" : "warn"}`;
      access.textContent = ok ? "accès réseau autorisé" : "accès réseau à autoriser";
    });
    const isDefault = cfg.settings.activeProviderId === p.id;
    return el(
      "div",
      { class: `card${p.enabled === false ? " off" : ""}`, dataset: { id: p.id } },
      el(
        "div",
        { class: "card-head" },
        el("span", { class: "title" }, p.name || p.baseUrl),
        el("span", { class: "badge" }, p.type === "anthropic" ? "Anthropic" : "compatible OpenAI"),
        isDefault ? el("span", { class: "badge ok" }, "par défaut") : null,
        p.enabled === false ? el("span", { class: "badge warn" }, "désactivé") : null,
        el("span", { class: "grow" }),
        access
      ),
      el("p", { class: "url" }, `${p.baseUrl} · token : ${p.token ? "défini" : "aucun"}${p.defaultModel ? ` · modèle : ${p.defaultModel}` : ""}`),
      el(
        "div",
        { class: "card-actions" },
        el("button", { class: "btn small", type: "button", onclick: edit }, "Modifier"),
        isDefault
          ? null
          : el("button", { class: "btn small", type: "button", onclick: async () => (await store.saveSettings({ activeProviderId: p.id }), rerender()) }, "Utiliser par défaut"),
        el(
          "button",
          {
            class: "btn small",
            type: "button",
            onclick: () => {
              const perm = requestHost(p.baseUrl); // 1er appel, synchrone
              perm.then(async (ok) => (setNotice(ok ? "Accès réseau autorisé." : "Accès refusé.", ok ? "ok" : "warn"), rerender()));
            },
          },
          "Autoriser l'accès réseau"
        ),
        confirmButton("Supprimer", "Confirmer la suppression", async () => {
          const c = await store.loadConfig();
          const rest = c.providers.filter((x) => x.id !== p.id);
          await store.saveProviders(rest);
          if (c.settings.activeProviderId === p.id) await store.saveSettings({ activeProviderId: rest[0]?.id ?? null });
          setNotice(`« ${p.name || p.baseUrl} » supprimé.`);
          rerender();
        })
      )
    );
  }

  function providerForm(draft, isNew, cfg, close) {
    const dlId = `models-${draft.id}`;
    const preset = el("select", {}, el("option", { value: "" }, "Personnalisé"), ...PRESETS.map((p) => el("option", { value: p.id }, p.label)));
    const name = el("input", { type: "text", value: draft.name, placeholder: "Mon fournisseur" });
    const type = el("select", {}, el("option", { value: "openai" }, "Compatible OpenAI"), el("option", { value: "anthropic" }, "Anthropic"));
    type.value = draft.type;
    const url = el("input", { type: "url", value: draft.baseUrl, placeholder: "https://api.openai.com/v1", spellcheck: false });
    const secret = secretInput(draft.token, "sk-…");
    const model = el("input", { type: "text", value: draft.defaultModel, list: dlId, placeholder: "ex. gpt-4o-mini", spellcheck: false, autocomplete: "off" });
    const datalist = el("datalist", { id: dlId }, ...chatModels(draft).map((m) => el("option", { value: m })));
    const headers = el("textarea", { rows: 3, class: "mono", placeholder: "X-Organization: mon-org" });
    headers.value = headersToText(draft.headers);
    const enabled = check("Activé (proposé dans la barre latérale)", draft.enabled !== false);
    const msg = flashBox();
    const insecure = el("div", { class: "flash warn", hidden: true }, "Cette URL utilise HTTP non chiffré vers un hôte distant : le token circulerait en clair sur le réseau. Préférez HTTPS.");
    const urlHint = el("span", { class: "hint" });

    const syncHints = () => {
      urlHint.textContent =
        type.value === "anthropic"
          ? "Exemple : https://api.anthropic.com — l'extension ajoute /v1/messages et /v1/models."
          : "URL de base, en général terminée par /v1 — l'extension ajoute /chat/completions, /models et /embeddings.";
      insecure.hidden = !isInsecureRemote(url.value.trim());
    };
    let presetName = ""; // dernier nom posé par un préréglage : remplacé tant que l'utilisateur ne l'a pas modifié
    preset.addEventListener("change", () => {
      const p = PRESETS.find((x) => x.id === preset.value);
      if (!p) return;
      type.value = p.type;
      url.value = p.baseUrl;
      if (!name.value.trim() || name.value === presetName) name.value = p.name;
      presetName = p.name;
      syncHints();
    });
    type.addEventListener("change", syncHints);
    url.addEventListener("input", syncHints);
    syncHints();

    const read = () => {
      const u = checkUrl(url.value);
      if (u.error) return { error: u.error };
      const s = checkSecret(secret.input.value);
      if (s.error) return { error: s.error };
      const h = checkHeaders(headers.value);
      if (h.error) return { error: h.error };
      return {
        provider: {
          ...draft,
          name: name.value.trim() || new URL(u.url).hostname,
          type: type.value,
          baseUrl: u.url.replace(/\/+$/, ""),
          token: s.token,
          headers: h.headers,
          defaultModel: model.value.trim(),
          enabled: enabled.input.checked,
        },
      };
    };

    const fillModels = (detailed) => {
      draft.models = detailed.map((m) => m.id);
      draft.modelKinds = Object.fromEntries(detailed.map((m) => [m.id, m.kind]));
      clear(datalist).append(...chatModels(draft).map((m) => el("option", { value: m }))); // seuls les modèles de génération de texte
    };
    model.addEventListener("change", () => {
      const m = model.value.trim();
      if (m && kindOf(draft, m) !== "chat") msg.set("Ce modèle ne semble pas être un modèle de génération de texte (embeddings, reranking, audio…) : il ne fonctionnera pas pour discuter.", "warn");
    });

    const runTest = async (p, perm) => {
      msg.set("Test en cours…", "info");
      const granted = await perm;
      const t = withTimeout(15000);
      try {
        const detailed = await listModelsDetailed(p, { signal: t.signal });
        fillModels(detailed);
        const usable = chatModels(draft);
        if ((!model.value.trim() || kindOf(draft, model.value.trim()) !== "chat") && usable.length) model.value = usable[0];
        const emb = detailed.filter((m) => m.kind === "embedding").length;
        msg.set(`Connexion réussie : ${usable.length} modèle(s) de discussion disponible(s)${emb ? ` (+ ${emb} d'embeddings, à régler dans l'onglet RAG)` : ""}.${granted ? "" : "\nL'accès réseau n'a pas été accordé : certains serveurs refuseront les requêtes."}`, granted ? "ok" : "warn");
      } catch (e) {
        msg.set(describeError(e, p), "error");
      } finally {
        t.dispose();
      }
    };

    const test = el(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: () => {
          const v = read();
          if (v.error) return msg.set(v.error, "error");
          runTest(v.provider, requestHost(v.provider.baseUrl)); // la demande de permission part ici, en synchrone
        },
      },
      "Tester et charger les modèles"
    );

    const save = el(
      "button",
      {
        class: "btn primary",
        type: "button",
        onclick: () => {
          const v = read();
          if (v.error) return msg.set(v.error, "error");
          const perm = requestHost(v.provider.baseUrl); // synchrone, avant tout await
          (async () => {
            const granted = await perm;
            const p = { ...v.provider, models: draft.models || [] };
            const c = await store.loadConfig();
            const i = c.providers.findIndex((x) => x.id === p.id);
            if (i === -1) c.providers.push(p);
            else c.providers[i] = p;
            await store.saveProviders(c.providers);
            if (!c.providers.some((x) => x.id === c.settings.activeProviderId)) await store.saveSettings({ activeProviderId: p.id });
            setNotice(`« ${p.name} » enregistré.${granted ? "" : " Attention : l'accès réseau à ce serveur n'a pas été autorisé."}`, granted ? "ok" : "warn");
            rerender();
          })();
        },
      },
      "Enregistrer"
    );

    return el(
      "div",
      { class: "form", dataset: { form: "provider" } },
      el("h3", {}, isNew ? "Nouveau fournisseur" : `Modifier « ${draft.name || draft.baseUrl} »`),
      el(
        "div",
        { class: "grid" },
        isNew ? field("Préréglage", preset, "Préremplit le nom, le type et l'URL.", "span2") : null,
        field("Nom", name),
        field("Type d'API", type),
        el("div", { class: "field span2" }, el("span", { class: "label" }, "URL de base de l'API"), url, urlHint, insecure),
        el("div", { class: "field span2" }, el("span", { class: "label" }, "Token / clé d'API"), secret.row, el("span", { class: "hint" }, "Enregistré en clair dans le profil Firefox (stockage local de l'extension) et envoyé uniquement à l'URL ci-dessus. Laissez vide pour un serveur local sans authentification.")),
        field("Modèle par défaut", el("div", {}, model, datalist), "« Tester et charger les modèles » remplit la liste de suggestions."),
        field("En-têtes HTTP supplémentaires", headers, "Optionnel, un par ligne : Nom: valeur."),
        el("div", { class: "span2" }, enabled.row)
      ),
      msg,
      el("div", { class: "row" }, save, test, el("button", { class: "btn", type: "button", onclick: close }, "Annuler"))
    );
  }

  // ======================= Serveurs MCP =======================

  async function renderMcp(view) {
    const cfg = await store.loadConfig();
    view.append(
      el("h2", {}, "Outils MCP"),
      el("p", { class: "lead" }, "Connectez des serveurs MCP (Model Context Protocol) : leurs outils deviennent disponibles pour le modèle."),
      el("div", { class: "callout" }, "Seuls les serveurs accessibles en HTTP(S) sont supportés : Streamable HTTP, avec repli automatique sur l'ancien transport HTTP+SSE. Une extension de navigateur ne peut pas lancer de processus local : pour un serveur « stdio », exposez-le via un pont HTTP."),
      listWithForm({
        items: cfg.mcpServers,
        addLabel: "+ Ajouter un serveur MCP",
        empty: "Aucun serveur MCP configuré.",
        newItem: () => store.newMcpServer(),
        renderCard: (s, edit) => mcpCard(s, edit),
        buildForm: (draft, isNew, close) => mcpForm(draft, isNew, close),
      })
    );
  }

  function mcpCard(s, edit) {
    return el(
      "div",
      { class: `card${s.enabled === false ? " off" : ""}`, dataset: { id: s.id } },
      el("div", { class: "card-head" }, el("span", { class: "title" }, s.name || s.url), el("span", { class: "badge" }, s.transport === "auto" ? "transport auto" : s.transport), s.enabled === false ? el("span", { class: "badge warn" }, "désactivé") : null),
      el("p", { class: "url" }, `${s.url} · token : ${s.token ? "défini" : "aucun"}`),
      el(
        "div",
        { class: "card-actions" },
        el("button", { class: "btn small", type: "button", onclick: edit }, "Modifier"),
        confirmButton("Supprimer", "Confirmer la suppression", async () => {
          const c = await store.loadConfig();
          await store.saveMcpServers(c.mcpServers.filter((x) => x.id !== s.id));
          await store.saveSettings({
            disabledTools: c.settings.disabledTools.filter((k) => !k.startsWith(`mcp:${s.id}:`)),
            approvedTools: c.settings.approvedTools.filter((k) => !k.startsWith(`mcp:${s.id}:`)),
          });
          setNotice(`« ${s.name || s.url} » supprimé.`);
          rerender();
        })
      )
    );
  }

  function mcpForm(draft, isNew, close) {
    const name = el("input", { type: "text", value: draft.name, placeholder: "Mon serveur MCP" });
    const url = el("input", { type: "url", value: draft.url, placeholder: "https://exemple.org/mcp", spellcheck: false });
    const secret = secretInput(draft.token);
    const transport = el("select", {}, el("option", { value: "auto" }, "Automatique (recommandé)"), el("option", { value: "streamable" }, "Streamable HTTP"), el("option", { value: "sse" }, "HTTP + SSE (ancien)"));
    transport.value = draft.transport;
    const headers = el("textarea", { rows: 3, class: "mono", placeholder: "X-Api-Key: …" });
    headers.value = headersToText(draft.headers);
    const enabled = check("Activé", draft.enabled !== false);
    const msg = flashBox();
    const insecure = el("div", { class: "flash warn", hidden: true }, "HTTP non chiffré vers un hôte distant : le token et les données des outils circuleraient en clair.");
    const syncWarn = () => (insecure.hidden = !isInsecureRemote(url.value.trim()));
    url.addEventListener("input", syncWarn);
    syncWarn();

    const read = () => {
      const u = checkUrl(url.value);
      if (u.error) return { error: u.error };
      const s = checkSecret(secret.input.value);
      if (s.error) return { error: s.error };
      const h = checkHeaders(headers.value);
      if (h.error) return { error: h.error };
      return { server: { ...draft, name: name.value.trim() || new URL(u.url).hostname, url: u.url, token: s.token, headers: h.headers, transport: transport.value, enabled: enabled.input.checked } };
    };

    const runTest = async (server, perm) => {
      msg.set("Connexion au serveur…", "info");
      const granted = await perm;
      const client = new McpClient(server);
      const t = withTimeout(25000);
      try {
        const tools = await client.listTools({ signal: t.signal, timeoutMs: 20000 });
        const info = client.serverInfo ? `${client.serverInfo.name ?? "serveur"} ${client.serverInfo.version ?? ""}`.trim() : "serveur";
        msg.set(`Connecté à ${info} (transport : ${client.transport?.kind}). ${tools.length} outil(s) :`, granted ? "ok" : "warn");
        msg.append(
          el("ul", { class: "toollist" }, ...tools.map((x) => el("li", {}, el("strong", {}, x.name), x.description ? el("span", { class: "d" }, ` — ${x.description.slice(0, 140)}`) : null)))
        );
      } catch (e) {
        msg.set(`Échec : ${e.message || e}${e.status === 401 || e.status === 403 ? "\nVérifiez le token / les en-têtes d'authentification." : ""}`, "error");
      } finally {
        t.dispose();
        client.close().catch(() => {});
      }
    };

    return el(
      "div",
      { class: "form", dataset: { form: "mcp" } },
      el("h3", {}, isNew ? "Nouveau serveur MCP" : `Modifier « ${draft.name || draft.url} »`),
      el(
        "div",
        { class: "grid" },
        field("Nom", name, "Sert de préfixe aux outils (ex. « Github__create_issue »)."),
        field("Transport", transport),
        el("div", { class: "field span2" }, el("span", { class: "label" }, "URL du serveur"), url, insecure),
        el("div", { class: "field span2" }, el("span", { class: "label" }, "Token (envoyé en « Authorization: Bearer … »)"), secret.row),
        field("En-têtes HTTP supplémentaires", headers, "Optionnel. Une ligne par en-tête : Nom: valeur. (Si vous définissez Authorization ici, le token ci-dessus est ignoré.)", "span2"),
        el("div", { class: "span2" }, enabled.row)
      ),
      msg,
      el(
        "div",
        { class: "row" },
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => {
              const v = read();
              if (v.error) return msg.set(v.error, "error");
              const perm = requestHost(v.server.url);
              (async () => {
                const granted = await perm;
                const c = await store.loadConfig();
                const i = c.mcpServers.findIndex((x) => x.id === v.server.id);
                if (i === -1) c.mcpServers.push(v.server);
                else c.mcpServers[i] = v.server;
                await store.saveMcpServers(c.mcpServers);
                setNotice(`« ${v.server.name} » enregistré.${granted ? "" : " Attention : l'accès réseau à ce serveur n'a pas été autorisé."}`, granted ? "ok" : "warn");
                rerender();
              })();
            },
          },
          "Enregistrer"
        ),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              const v = read();
              if (v.error) return msg.set(v.error, "error");
              runTest(v.server, requestHost(v.server.url));
            },
          },
          "Tester la connexion"
        ),
        el("button", { class: "btn", type: "button", onclick: close }, "Annuler")
      )
    );
  }

  // ======================= RAG =======================

  async function renderRag(view) {
    const cfg = await store.loadConfig();
    const collections = await ragdb.listCollections();
    view.append(
      el("h2", {}, "RAG — bases de connaissances"),
      el("p", { class: "lead" }, "Importez des documents dans des collections locales (stockées dans le navigateur) ou référencez un service RAG externe : le modèle pourra les interroger comme un outil."),
      embeddingSection(cfg),
      collectionsSection(cfg, collections),
      el("h3", {}, "Services RAG distants (HTTP)"),
      el("p", { class: "hint" }, "Référencez un endpoint qui reçoit une requête en JSON et renvoie des extraits. Il devient un outil que le modèle peut appeler."),
      listWithForm({
        items: cfg.remoteRag,
        addLabel: "+ Ajouter un service RAG distant",
        empty: "Aucun service RAG distant.",
        newItem: () => store.newRemoteRag(),
        renderCard: (r, edit) => remoteRagCard(r, edit),
        buildForm: (draft, isNew, close) => remoteRagForm(draft, isNew, close),
      })
    );
  }

  function embeddingSection(cfg) {
    const s = cfg.settings;
    const openaiProviders = cfg.providers.filter((p) => p.type === "openai");
    const provider = el("select", {}, el("option", { value: "" }, "— aucun (recherche lexicale BM25 seule) —"), ...openaiProviders.map((p) => el("option", { value: p.id }, p.name || p.baseUrl)));
    provider.value = s.embedding?.providerId ?? "";
    const embDl = el("datalist", { id: "emb-models" });
    const model = el("input", { type: "text", value: s.embedding?.model ?? "", list: "emb-models", placeholder: "ex. text-embedding-3-small, nomic-embed-text", spellcheck: false, autocomplete: "off" });
    const fillEmbModels = () => {
      const p = openaiProviders.find((x) => x.id === provider.value);
      clear(embDl).append(...(p ? embeddingModels(p) : []).map((m) => el("option", { value: m })));
    };
    fillEmbModels();
    provider.addEventListener("change", fillEmbModels);
    const chunk = el("input", { type: "number", min: 200, max: 8000, step: 50, value: s.ragChunkSize });
    const overlap = el("input", { type: "number", min: 0, max: 2000, step: 10, value: s.ragChunkOverlap });
    const topk = el("input", { type: "number", min: 1, max: 20, value: s.ragTopK });
    const msg = flashBox();
    const num = (n, d, lo, hi) => Math.min(hi, Math.max(lo, parseInt(n.value, 10) || d));
    const saveAll = async () => {
      await store.saveSettings({
        embedding: { providerId: provider.value || null, model: model.value.trim() },
        ragChunkSize: num(chunk, 1000, 200, 8000),
        ragChunkOverlap: num(overlap, 150, 0, 2000),
        ragTopK: num(topk, 5, 1, 20),
      });
      msg.set("Enregistré.", "ok");
    };
    for (const n of [provider, model, chunk, overlap, topk]) n.addEventListener("change", saveAll);
    const test = el(
      "button",
      {
        class: "btn small",
        type: "button",
        onclick: async () => {
          const p = openaiProviders.find((x) => x.id === provider.value);
          if (!p || !model.value.trim()) return msg.set("Choisissez un fournisseur et un modèle d'embeddings.", "error");
          msg.set("Test en cours…", "info");
          const t = withTimeout(20000);
          try {
            const [v] = await embed(p, model.value.trim(), ["test"], { signal: t.signal });
            msg.set(`Embeddings opérationnels (dimension : ${v.length}).`, "ok");
          } catch (e) {
            msg.set(describeError(e, p), "error");
          } finally {
            t.dispose();
          }
        },
      },
      "Tester les embeddings"
    );
    return el(
      "div",
      { class: "card" },
      el("div", { class: "card-head" }, el("span", { class: "title" }, "Recherche et embeddings")),
      el("p", { class: "hint" }, "Sans modèle d'embeddings, la recherche est lexicale (BM25). Avec un modèle, elle devient hybride (lexicale + sémantique). Le modèle est enregistré dans chaque collection à sa création ; pour changer, utilisez « Réindexer »."),
      el("div", { class: "grid" }, field("Fournisseur d'embeddings (compatible OpenAI)", provider), field("Modèle d'embeddings", el("div", {}, model, embDl), "Les modèles d'embeddings du fournisseur sont proposés (champ à remplir après « Tester et charger les modèles » dans l'onglet Fournisseurs)."), field("Taille des extraits (caractères)", chunk), field("Recouvrement (caractères)", overlap), field("Extraits renvoyés (top-k)", topk)),
      el("div", { class: "row" }, test),
      msg
    );
  }

  function collectionsSection(cfg, collections) {
    const wrap = el("div");
    const newName = el("input", { type: "text", placeholder: "Nom de la nouvelle collection (ex. Documentation produit)" });
    const msg = flashBox();
    const create = async () => {
      const n = newName.value.trim();
      if (!n) return msg.set("Donnez un nom à la collection.", "error");
      const emb = cfg.settings.embedding;
      const c = await ragdb.createCollection(n, emb?.providerId && emb?.model ? emb : null);
      selectedCollection = c.id;
      setNotice(`Collection « ${c.name} » créée.`);
      rerender();
    };
    newName.addEventListener("keydown", (e) => e.key === "Enter" && create());
    wrap.append(
      el("h3", {}, "Collections locales"),
      el("div", { class: "row", style: "margin-top:0" }, el("div", { class: "grow" }, newName), el("button", { class: "btn primary", type: "button", onclick: create }, "Créer")),
      msg
    );
    const cards = el("div", { class: "cards" });
    if (!collections.length) cards.append(el("p", { class: "muted" }, "Aucune collection."));
    for (const c of collections) cards.append(collectionCard(c, cfg));
    wrap.append(cards);
    const sel = collections.find((c) => c.id === selectedCollection);
    if (sel) wrap.append(documentsPanel(sel, cfg));
    return wrap;
  }

  function collectionCard(c, cfg) {
    const emb = cfg.settings.embedding;
    const wanted = emb?.providerId && emb?.model ? emb : null;
    const differs = wanted && (!c.embedding || c.embedding.providerId !== wanted.providerId || c.embedding.model !== wanted.model);
    const msg = flashBox();
    const reindex = el(
      "button",
      {
        class: "btn small",
        type: "button",
        onclick: async () => {
          const embedder = await services.getEmbedder(wanted);
          if (!embedder) return msg.set("Fournisseur d'embeddings introuvable.", "error");
          msg.set("Réindexation…", "info");
          try {
            await ragdb.reindexEmbeddings(c.id, wanted, (texts) => embedder(texts), { onProgress: (d, t) => msg.set(`Réindexation : ${d}/${t}`, "info") });
            setNotice(`« ${c.name} » réindexée avec ${wanted.model}.`);
            rerender();
          } catch (e) {
            msg.set(describeError(e), "error");
          }
        },
      },
      "Réindexer avec les embeddings actuels"
    );
    return el(
      "div",
      { class: "card", dataset: { id: c.id } },
      el(
        "div",
        { class: "card-head" },
        el("span", { class: "title" }, c.name),
        el("span", { class: "badge" }, `${c.docCount} document(s)`),
        el("span", { class: "badge" }, `${c.chunkCount} extraits`),
        c.embedding ? el("span", { class: "badge ok" }, `embeddings : ${c.embedding.model}${c.embedding.dim ? ` (${c.embedding.dim})` : ""}`) : el("span", { class: "badge" }, "BM25 seul")
      ),
      el(
        "div",
        { class: "card-actions" },
        el("button", { class: "btn small", type: "button", onclick: () => ((selectedCollection = selectedCollection === c.id ? null : c.id), rerender()) }, selectedCollection === c.id ? "Masquer les documents" : "Gérer les documents"),
        differs && c.chunkCount ? reindex : null,
        confirmButton("Supprimer", "Confirmer la suppression", async () => {
          await ragdb.deleteCollection(c.id);
          const s = (await store.loadConfig()).settings;
          await store.saveSettings({ ragCollectionIds: s.ragCollectionIds.filter((x) => x !== c.id) });
          if (selectedCollection === c.id) selectedCollection = null;
          setNotice(`Collection « ${c.name} » supprimée.`);
          rerender();
        })
      ),
      msg
    );
  }

  const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|png|jpe?g|gif|webp|zip|gz|7z|rar|exe|bin|mp[34]|mov)$/i;
  const MAX_FILE = 20 * 1024 * 1024;

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, "text/html"); // document inerte : aucun script exécuté
    doc.querySelectorAll("script,style,noscript,template").forEach((n) => n.remove());
    doc.querySelectorAll("p,div,li,tr,h1,h2,h3,h4,h5,h6,br,section,article,pre,blockquote").forEach((n) => n.after(doc.createTextNode("\n")));
    return (doc.body?.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  }

  const MAX_SQLITE = 500 * 1024 * 1024;
  const stem = (name) => name.replace(/\.[^.]+$/, "");

  /**
   * Transforme un fichier en documents à indexer. Une base `chroma.sqlite3` ou un export JSON de Chroma donne un
   * document par source ; tout autre fichier donne un seul document. Les vecteurs de Chroma ne sont pas repris :
   * les extraits sont ré-encodés avec le modèle d'embeddings de la collection.
   */
  async function fileToDocuments(file) {
    if (/\.(sqlite3?|db)$/i.test(file.name) || file.buffer) {
      if (file.size > MAX_SQLITE) throw new Error("base trop volumineuse (max. 500 Mo).");
      const buf = new Uint8Array(file.buffer ?? (await file.arrayBuffer()));
      if (!isSqliteBuffer(buf)) throw new Error("ce fichier n'est pas une base SQLite (attendu : chroma.sqlite3).");
      const { collections, warnings } = readChromaSqlite(buf);
      const docs = collections.flatMap((c) => chromaToDocuments(c, { fallbackName: stem(file.name) }));
      const n = collections.reduce((a, c) => a + c.records.length, 0);
      return { docs, note: `base Chroma : ${collections.length} collection(s), ${n} enregistrement(s)`, warnings };
    }
    const text = file.content ?? (await readFileAsText(file));
    if (/\.(json|jsonl|ndjson)$/i.test(file.name)) {
      const parsed = parseChromaJson(text);
      if (parsed) {
        const docs = parsed.collections.flatMap((c) => chromaToDocuments(c, { fallbackName: stem(file.name) }));
        const n = parsed.collections.reduce((a, c) => a + c.records.length, 0);
        return { docs, note: `export Chroma : ${n} enregistrement(s)`, warnings: [] };
      }
    }
    return { docs: [{ name: file.name, text }], note: "", warnings: [] };
  }

  async function readFileAsText(file) {
    if (BINARY_EXT.test(file.name)) throw new Error("format non supporté (convertissez-le en texte, Markdown ou HTML).");
    if (file.size > MAX_FILE) throw new Error("fichier trop volumineux (max. 20 Mo).");
    let text = await file.text();
    if (text.includes("\u0000")) throw new Error("fichier binaire non supporté.");
    if (/\.html?$/i.test(file.name)) text = htmlToText(text);
    return text;
  }

  /** Importe des fichiers (ou pseudo-fichiers { name, size, text() }) dans une collection. */
  async function importDocuments(colId, files, ui) {
    const settings = (await store.loadConfig()).settings;
    const col = await ragdb.getCollection(colId);
    let embedder = null;
    if (col.embedding) {
      const e = await services.getEmbedder(col.embedding);
      if (!e) {
        ui.log("Le fournisseur d'embeddings de cette collection est introuvable : ajoutez-le ou réindexez la collection.", "error");
        return;
      }
      embedder = (texts) => e(texts);
    }
    for (const file of files) {
      const li = ui.log(`${file.name} : lecture…`);
      try {
        const { docs, note, warnings } = await fileToDocuments(file);
        if (!docs.length) throw new Error("aucun texte exploitable.");
        let done = 0;
        const failed = [];
        for (const [i, d] of docs.entries()) {
          li.textContent = `${file.name} : ${note ? note + " — " : ""}indexation ${i + 1}/${docs.length}…`;
          try {
            await ragdb.addDocument(colId, { name: d.name, text: d.text }, {
              chunkSize: settings.ragChunkSize,
              overlap: settings.ragChunkOverlap,
              embedder,
              onProgress: (p, t) => ui.progress((i + p / t) / docs.length),
            });
            done++;
          } catch (e) {
            failed.push(`${d.name} (${e.message || e})`);
          }
        }
        if (!done) throw new Error(failed[0] ?? "aucun document importé.");
        li.className = failed.length ? "warn" : "ok";
        li.textContent =
          `${file.name} : importé` + (note ? ` (${note}` + `, ${done} document(s))` : "") + (failed.length ? ` — ${failed.length} ignoré(s) : ${failed.slice(0, 3).join(" ; ")}` : "") + (warnings.length ? ` — ${warnings.join(" ")}` : "");
      } catch (e) {
        li.className = "error";
        li.textContent = `${file.name} : ${e.message ? describeError(e) : e}`;
      }
    }
    ui.progress(0);
  }

  function documentsPanel(col, cfg) {
    const logList = el("ul", { class: "log" });
    const bar = el("div", {});
    const progress = el("div", { class: "progress", hidden: true }, bar);
    const ui = {
      log(text, cls = "") {
        const li = el("li", { class: cls }, text);
        logList.append(li);
        return li;
      },
      progress(f) {
        progress.hidden = !f;
        bar.style.width = `${Math.round(f * 100)}%`;
      },
    };
    const docsBody = el("tbody");
    const paintDocs = async () => {
      const docs = await ragdb.listDocuments(col.id);
      clear(docsBody);
      if (!docs.length) docsBody.append(el("tr", {}, el("td", { colspan: 4, class: "muted" }, "Aucun document.")));
      for (const d of docs) {
        docsBody.append(
          el(
            "tr",
            {},
            el("td", {}, d.name),
            el("td", {}, `${d.chunkCount} extraits`),
            el("td", {}, new Date(d.addedAt).toLocaleDateString("fr-FR")),
            el("td", {}, el("button", { class: "btn small danger", type: "button", onclick: async () => (await ragdb.deleteDocument(d.id), rerender()) }, "Supprimer"))
          )
        );
      }
    };
    paintDocs();

    const busy = { v: false };
    const run = async (files) => {
      if (busy.v) return;
      busy.v = true;
      try {
        await importDocuments(col.id, files, ui);
      } finally {
        busy.v = false;
        rerender();
      }
    };
    const picker = el("input", { type: "file", multiple: true, accept: ".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.ndjson,.sqlite3,.sqlite,.db,.html,.htm,.xml,.log,.yaml,.yml,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.sh,.sql,.rst,.tex,text/*" });
    picker.addEventListener("change", () => picker.files?.length && run([...picker.files]));
    const pasteName = el("input", { type: "text", placeholder: "Nom du document (ex. notes.md)" });
    const pasteText = el("textarea", { rows: 5, placeholder: "Collez du texte ici…" });
    const addPaste = el(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: () => {
          const content = pasteText.value;
          if (!content.trim()) return ui.log("Rien à ajouter : le texte est vide.", "error");
          run([{ name: pasteName.value.trim() || `texte-${new Date().toISOString().slice(0, 16)}.txt`, content }]);
        },
      },
      "Ajouter le texte"
    );

    return el(
      "div",
      { class: "form", dataset: { form: "documents" } },
      el("h3", {}, `Documents de « ${col.name} »`),
      el("table", { class: "docs" }, el("thead", {}, el("tr", {}, el("th", {}, "Document"), el("th", {}, "Taille"), el("th", {}, "Ajouté"), el("th", {}))), docsBody),
      el(
        "div",
        { class: "import" },
        el("strong", {}, "Importer des fichiers"),
        el("p", { class: "hint" }, "Texte, Markdown, CSV, JSON, HTML, code source… ainsi que ChromaDB (base chroma.sqlite3 ou export JSON/JSONL : un document par source, ré-indexé avec les embeddings de cette collection). Les PDF et documents Office ne sont pas supportés : convertissez-les en texte."),
        picker,
        el("div", { class: "field", style: "margin-top:12px" }, el("span", { class: "label" }, "Ou coller du texte"), pasteName, pasteText),
        el("div", { class: "row" }, addPaste),
        progress,
        logList
      )
    );
  }

  function remoteRagCard(r, edit) {
    return el(
      "div",
      { class: `card${r.enabled === false ? " off" : ""}`, dataset: { id: r.id } },
      el("div", { class: "card-head" }, el("span", { class: "title" }, r.name || r.url), r.enabled === false ? el("span", { class: "badge warn" }, "désactivé") : null),
      el("p", { class: "url" }, `${r.url} · token : ${r.token ? "défini" : "aucun"}`),
      el(
        "div",
        { class: "card-actions" },
        el("button", { class: "btn small", type: "button", onclick: edit }, "Modifier"),
        confirmButton("Supprimer", "Confirmer la suppression", async () => {
          const c = await store.loadConfig();
          await store.saveRemoteRag(c.remoteRag.filter((x) => x.id !== r.id));
          setNotice(`« ${r.name || r.url} » supprimé.`);
          rerender();
        })
      )
    );
  }

  function remoteRagForm(draft, isNew, close) {
    const name = el("input", { type: "text", value: draft.name, placeholder: "Wiki interne" });
    const desc = el("textarea", { rows: 2 });
    desc.value = draft.description;
    const url = el("input", { type: "url", value: draft.url, placeholder: "https://rag.exemple.org/search", spellcheck: false });
    const secret = secretInput(draft.token);
    const headers = el("textarea", { rows: 2, class: "mono" });
    headers.value = headersToText(draft.headers);
    const body = el("textarea", { rows: 3, class: "mono" });
    body.value = draft.bodyTemplate;
    const path = el("input", { type: "text", value: draft.resultPath, placeholder: "ex. results ou data.items (optionnel)", spellcheck: false });
    const enabled = check("Activé", draft.enabled !== false);
    const msg = flashBox();

    const read = () => {
      const u = checkUrl(url.value);
      if (u.error) return { error: u.error };
      const s = checkSecret(secret.input.value);
      if (s.error) return { error: s.error };
      const h = checkHeaders(headers.value);
      if (h.error) return { error: h.error };
      const tpl = body.value.trim() || '{"query": "{{query}}", "top_k": {{top_k}}}';
      const probe = tpl.replace(/\{\{(query|top_k)\}\}/g, (_, k) => (k === "query" ? "x" : "1"));
      try {
        JSON.parse(probe);
      } catch {
        return { error: "Le modèle de corps n'est pas un JSON valide une fois {{query}} et {{top_k}} remplacés." };
      }
      return { rag: { ...draft, name: name.value.trim() || new URL(u.url).hostname, description: desc.value.trim(), url: u.url, token: s.token, headers: h.headers, bodyTemplate: tpl, resultPath: path.value.trim(), enabled: enabled.input.checked } };
    };

    const runTest = async (rag, perm) => {
      msg.set("Requête de test…", "info");
      await perm;
      const reg = new ToolRegistry({ getConfig: async () => ({ mcpServers: [], remoteRag: [rag], settings: { ...store.DEFAULT_SETTINGS } }) });
      await reg.refresh();
      const r = await reg.call(reg.list()[0].wireName, { query: "test", top_k: 3 });
      msg.set(r.isError ? r.text : `Réponse reçue :\n${r.text.slice(0, 600)}`, r.isError ? "error" : "ok");
    };

    return el(
      "div",
      { class: "form", dataset: { form: "remote-rag" } },
      el("h3", {}, isNew ? "Nouveau service RAG distant" : `Modifier « ${draft.name || draft.url} »`),
      el(
        "div",
        { class: "grid" },
        field("Nom", name, "Devient le nom de l'outil proposé au modèle."),
        field("URL (POST)", url),
        field("Description pour le modèle", desc, "Expliquez ce que contient cette base : le modèle s'en sert pour décider quand l'interroger.", "span2"),
        el("div", { class: "field span2" }, el("span", { class: "label" }, "Token (Bearer)"), secret.row),
        field("En-têtes supplémentaires", headers, "Un par ligne : Nom: valeur.", "span2"),
        field("Modèle du corps JSON", body, "Variables : {{query}} (échappée automatiquement) et {{top_k}}.", "span2"),
        field("Chemin du résultat", path, "Chemin pointé vers la liste d'extraits dans la réponse JSON. Vide = réponse entière."),
        el("div", {}, enabled.row)
      ),
      msg,
      el(
        "div",
        { class: "row" },
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => {
              const v = read();
              if (v.error) return msg.set(v.error, "error");
              const perm = requestHost(v.rag.url);
              (async () => {
                const granted = await perm;
                const c = await store.loadConfig();
                const i = c.remoteRag.findIndex((x) => x.id === v.rag.id);
                if (i === -1) c.remoteRag.push(v.rag);
                else c.remoteRag[i] = v.rag;
                await store.saveRemoteRag(c.remoteRag);
                setNotice(`« ${v.rag.name} » enregistré.${granted ? "" : " Attention : l'accès réseau n'a pas été autorisé."}`, granted ? "ok" : "warn");
                rerender();
              })();
            },
          },
          "Enregistrer"
        ),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => {
              const v = read();
              if (v.error) return msg.set(v.error, "error");
              runTest(v.rag, requestHost(v.rag.url));
            },
          },
          "Tester"
        ),
        el("button", { class: "btn", type: "button", onclick: close }, "Annuler")
      )
    );
  }

  // ======================= Général =======================

  const SECRET_HEADER = /auth|key|token|secret|cookie/i;

  async function exportConfig(includeSecrets) {
    const cfg = await store.loadConfig();
    const clean = (o) => ({
      ...o,
      token: includeSecrets ? o.token : "",
      headers: includeSecrets ? o.headers : Object.fromEntries(Object.entries(o.headers || {}).filter(([k]) => !SECRET_HEADER.test(k))),
    });
    const { approvedTools, ...settings } = cfg.settings; // les autorisations ne s'exportent pas
    if (!includeSecrets) settings.webSearchToken = "";
    return {
      format: "ai-chat-sidebar-config",
      version: 1,
      secretsIncluded: !!includeSecrets,
      providers: cfg.providers.map(clean),
      mcpServers: cfg.mcpServers.map(clean),
      remoteRag: cfg.remoteRag.map(clean),
      settings,
    };
  }

  async function importConfig(data) {
    if (!data || data.format !== "ai-chat-sidebar-config" || !Array.isArray(data.providers)) throw new Error("Fichier de configuration non reconnu.");
    const cur = await store.loadConfig();
    const merge = (incoming, existing, make) =>
      (incoming ?? []).map((x) => {
        const old = existing.find((e) => e.id === x.id);
        const item = make(x);
        if (!item.token && old?.token) item.token = old.token; // on conserve le token local si l'export n'en contient pas
        if (old && Object.keys(item.headers || {}).length === 0) item.headers = old.headers;
        return item;
      });
    await store.saveProviders(merge(data.providers, cur.providers, (x) => store.newProvider(x)));
    await store.saveMcpServers(merge(data.mcpServers, cur.mcpServers, (x) => store.newMcpServer(x)));
    await store.saveRemoteRag(merge(data.remoteRag, cur.remoteRag, (x) => store.newRemoteRag(x)));
    const { approvedTools, ...settings } = data.settings ?? {};
    if (!settings.webSearchToken) delete settings.webSearchToken; // conserve le token local
    await store.saveSettings(settings);
  }

  async function renderGeneral(view) {
    const cfg = await store.loadConfig();
    const s = cfg.settings;
    const msg = flashBox();
    const saved = async (patch) => {
      await store.saveSettings(patch);
      msg.set("Enregistré.", "ok");
    };
    const sys = el("textarea", { rows: 4 });
    sys.value = s.systemPrompt;
    sys.addEventListener("change", () => saved({ systemPrompt: sys.value }));
    const numberField = (label, key, { min, max, step = 1, hint, nullable = false }) => {
      const input = el("input", { type: "number", min, max, step, value: s[key] ?? "", placeholder: nullable ? "défaut du serveur" : "" });
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        if (!raw) return nullable ? saved({ [key]: null }) : (input.value = s[key]);
        const n = Math.min(max, Math.max(min, Number(raw)));
        input.value = n;
        saved({ [key]: n });
      });
      return field(label, input, hint);
    };
    const autoRetry = check("Relancer automatiquement à la fin de l'attente (3 fois au plus) au lieu de seulement le proposer", s.rateLimitAutoRetry);
    autoRetry.input.addEventListener("change", () => saved({ rateLimitAutoRetry: autoRetry.input.checked }));
    const toolsOn = check("Activer les outils (MCP et RAG)", s.toolsEnabled);
    toolsOn.input.addEventListener("change", () => saved({ toolsEnabled: toolsOn.input.checked }));
    const confirm = check("Demander confirmation avant chaque exécution d'outil (recommandé)", s.confirmTools);
    confirm.input.addEventListener("change", () => saved({ confirmTools: confirm.input.checked }));

    // ---- Recherche web ----
    const web = { webSearchEnabled: s.webSearchEnabled, webEngine: s.webEngine, webSearchUrl: s.webSearchUrl, webSearchToken: s.webSearchToken, webMaxResults: s.webMaxResults, webFetchEnabled: s.webFetchEnabled };
    const webMsg = flashBox();
    const webOn = check("Activer la recherche web (outils web_search et web_fetch pour le modèle)", s.webSearchEnabled);
    const fetchOn = check("Autoriser aussi la lecture du contenu des pages (web_fetch, accès à tous les sites)", s.webFetchEnabled !== false);
    const engine = el("select", {}, ...Object.entries(WEB_ENGINES).map(([id, e]) => el("option", { value: id, text: e.label })));
    engine.value = WEB_ENGINES[s.webEngine] ? s.webEngine : "duckduckgo";
    const webUrl = el("input", { type: "url", value: s.webSearchUrl, placeholder: "https://searx.exemple.org", spellcheck: "false", autocomplete: "off" });
    const webToken = el("input", { type: "password", value: s.webSearchToken, placeholder: "clé API (Brave) — optionnel pour SearXNG", spellcheck: "false", autocomplete: "off" });
    const webCount = el("input", { type: "number", min: 1, max: 10, value: s.webMaxResults });
    const urlField = field("URL de l'instance SearXNG", webUrl, "Le format JSON doit être activé côté serveur (search.formats: [html, json]).");
    const tokenField = field("Clé API / token", webToken, "Stocké en clair dans le profil Firefox, comme les autres tokens.");
    const syncWebFields = () => {
      const e = WEB_ENGINES[engine.value];
      urlField.hidden = !e.needsUrl;
      tokenField.hidden = !(e.needsToken || engine.value === "searxng");
    };
    syncWebFields();
    const saveWeb = async (patch) => {
      Object.assign(web, patch);
      await store.saveSettings(patch);
      webMsg.set("Enregistré.", "ok");
    };
    // Les demandes d'autorisation partent de façon synchrone depuis le clic / changement.
    const askWebAccess = () => {
      const origins = webOrigins(web);
      if (!origins.length || !api?.permissions?.request) return Promise.resolve(true);
      try {
        return Promise.resolve(api.permissions.request({ origins })).catch(() => false);
      } catch {
        return Promise.resolve(false);
      }
    };
    webOn.input.addEventListener("change", () => {
      const on = webOn.input.checked;
      const perm = on ? askWebAccess() : Promise.resolve(true);
      perm.then(async (ok) => {
        if (!ok) {
          webOn.input.checked = false;
          return webMsg.set("Autorisation refusée : la recherche web reste désactivée.", "warn");
        }
        await saveWeb(on ? { webSearchEnabled: true, toolsEnabled: true } : { webSearchEnabled: false });
      });
    });
    fetchOn.input.addEventListener("change", () => {
      Object.assign(web, { webFetchEnabled: fetchOn.input.checked });
      const perm = fetchOn.input.checked && web.webSearchEnabled ? askWebAccess() : Promise.resolve(true);
      perm.then(async (ok) => {
        if (!ok) {
          fetchOn.input.checked = false;
          Object.assign(web, { webFetchEnabled: false });
        }
        await saveWeb({ webFetchEnabled: fetchOn.input.checked });
      });
    });
    engine.addEventListener("change", () => (syncWebFields(), saveWeb({ webEngine: engine.value })));
    webUrl.addEventListener("change", () => {
      const v = webUrl.value.trim();
      if (v && checkUrl(v).error) return webMsg.set("URL invalide.", "error");
      saveWeb({ webSearchUrl: v });
    });
    webToken.addEventListener("change", () => {
      const r = checkSecret(webToken.value);
      if (r.error) return webMsg.set(r.error, "error");
      saveWeb({ webSearchToken: r.token });
    });
    webCount.addEventListener("change", () => {
      const n = Math.min(10, Math.max(1, parseInt(webCount.value, 10) || 5));
      webCount.value = n;
      saveWeb({ webMaxResults: n });
    });
    const webTest = el(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: () => {
          const perm = askWebAccess();
          webTest.disabled = true;
          webMsg.set("Test en cours…", "ok");
          perm
            .then(async (ok) => {
              if (!ok) return webMsg.set("Autorisation refusée.", "warn");
              const results = await webSearch({ ...s, ...web }, "Mozilla Firefox");
              webMsg.set(results.length ? `${results.length} résultat(s). Premier : ${results[0].title} — ${results[0].url}` : "Connexion OK mais aucun résultat.", results.length ? "ok" : "warn");
            })
            .catch((e) => webMsg.set(`Échec : ${e.message || e}`, "error"))
            .finally(() => (webTest.disabled = false));
        },
      },
      "Tester la recherche"
    );

    // ---- Affichage (popup / barre latérale) ----
    const mode = el("select", {}, el("option", { value: "sidebar", text: "Barre latérale (défaut)" }), el("option", { value: "popup", text: "Fenêtre popup" }));
    mode.value = s.openMode === "popup" ? "popup" : "sidebar";
    mode.addEventListener("change", () => saved({ openMode: mode.value }));

    const withSecrets = check("Inclure les tokens et en-têtes d'authentification (déconseillé)", false);
    const io = flashBox();
    const exportBtn = el(
      "button",
      {
        class: "btn",
        type: "button",
        onclick: async () => {
          const data = await exportConfig(withSecrets.input.checked);
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const a = el("a", { href: URL.createObjectURL(blob), download: "ai-chat-config.json" });
          document.body.append(a);
          a.click();
          a.remove();
          io.set(withSecrets.input.checked ? "Exporté, tokens inclus : conservez ce fichier en lieu sûr." : "Exporté sans les tokens.", withSecrets.input.checked ? "warn" : "ok");
        },
      },
      "Exporter la configuration"
    );
    const importInput = el("input", { type: "file", accept: ".json,application/json" });
    importInput.addEventListener("change", async () => {
      try {
        const file = importInput.files[0];
        if (!file) return;
        await importConfig(JSON.parse(await file.text()));
        setNotice("Configuration importée. Les tokens absents du fichier ont été conservés.");
        rerender();
      } catch (e) {
        io.set(`Import impossible : ${e.message}`, "error");
      }
    });

    view.append(
      el("h2", {}, "Général"),
      msg,
      el("h3", {}, "Comportement du modèle"),
      el("div", { class: "grid" }, field("Prompt système", sys, "Instructions envoyées au début de chaque conversation.", "span2"), numberField("Température", "temperature", { min: 0, max: 2, step: 0.1, nullable: true, hint: "Vide = valeur par défaut du serveur. Certains modèles de raisonnement refusent ce paramètre." }), numberField("Longueur max. de réponse (API Anthropic)", "maxTokens", { min: 256, max: 128000, step: 256, hint: "Paramètre obligatoire pour Anthropic ; ignoré pour les API compatibles OpenAI." })),
      el("h3", {}, "Limite de requêtes (HTTP 429)"),
      el("div", { class: "grid" }, numberField("Attente avant de proposer la relance (secondes)", "rateLimitWaitSec", { min: 1, max: 3600, hint: "Défaut : 180 s (3 minutes). Si le serveur envoie un en-tête Retry-After plus long, il est respecté." }), el("div", { class: "span2" }, autoRetry.row)),
      el("h3", {}, "Affichage"),
      el("div", { class: "grid" }, field("Le bouton de la barre d'outils ouvre", mode, "En popup, la fenêtre se ferme dès que vous cliquez ailleurs et interrompt une réponse en cours. Le raccourci Alt+Maj+Y ouvre toujours la barre latérale.")),
      el("h3", {}, "Recherche web"),
      webMsg,
      el("div", { class: "grid" }, el("div", { class: "span2" }, webOn.row), field("Moteur de recherche", engine), field("Nombre de résultats", webCount), el("div", { class: "span2" }, urlField), el("div", { class: "span2" }, tokenField), el("div", { class: "span2" }, fetchOn.row)),
      el("div", { class: "row" }, webTest),
      el("p", { class: "hint" }, "Le modèle ne reçoit que les extraits renvoyés par le moteur ; les requêtes et pages demandées sont visibles dans la carte d'outil et soumises à confirmation. Les adresses locales et privées sont refusées par web_fetch."),
      el("h3", {}, "Outils"),
      el("div", { class: "grid" }, el("div", { class: "span2" }, toolsOn.row), el("div", { class: "span2" }, confirm.row), numberField("Tours d'outils maximum par message", "maxToolRounds", { min: 0, max: 30, hint: "Évite les boucles d'appels sans fin." }), numberField("Taille max. d'un résultat d'outil (caractères)", "maxToolResultChars", { min: 1000, max: 200000, step: 1000 })),
      el(
        "p",
        { class: "hint" },
        `Outils autorisés en permanence : ${s.approvedTools.length}. `,
        s.approvedTools.length ? el("button", { class: "btn small", type: "button", onclick: async () => (await store.saveSettings({ approvedTools: [] }), setNotice("Autorisations réinitialisées."), rerender()) }, "Tout réinitialiser") : null
      ),
      el("h3", {}, "Sauvegarde de la configuration"),
      el("div", { class: "row", style: "margin-top:0" }, exportBtn, withSecrets.row),
      el("div", { class: "row" }, el("span", {}, "Importer :"), importInput),
      io,
      el("h3", {}, "Données"),
      el("div", { class: "row", style: "margin-top:0" }, confirmButton("Supprimer toutes les conversations", "Confirmer : tout supprimer", async () => (await store.deleteAllConversations(), await store.setLastConversationId(null), setNotice("Conversations supprimées."), rerender()))),
      el("div", { class: "callout" }, "Confidentialité : l'extension n'a aucun serveur propre. Vos messages, extraits RAG et résultats d'outils ne sont envoyés qu'aux URLs que vous configurez. Les tokens sont stockés en clair dans le profil Firefox : n'utilisez que des clés révocables et, si possible, à portée limitée.")
    );
  }

  const RENDER = { providers: renderProviders, mcp: renderMcp, rag: renderRag, general: renderGeneral };

  const initial = (location.hash || "").slice(1);
  await show(RENDER[initial] ? initial : "providers");
  return { show, importDocuments, exportConfig, importConfig, services };
}

if (!globalThis.__AICHAT_NO_AUTOINIT__) init();
