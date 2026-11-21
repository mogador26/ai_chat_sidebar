// Barre latérale : chat en streaming, outils (MCP / RAG) avec confirmation, historique.
import { el, clear, icon, hydrateIcons, sleep } from "../lib/dom.js";
import { renderMarkdown } from "../lib/markdown.js";
import * as store from "../lib/storage.js";
import { listModelsDetailed, describeError, LLMError, kindOf, chatModels } from "../lib/llm.js";
import * as ragdb from "../lib/ragdb.js";
import { createServices } from "../lib/services.js";
import { runAgent } from "../lib/agent.js";
import { splitThink, originPattern } from "../lib/util.js";
import { webOrigins } from "../lib/web.js";

const api = globalThis.browser ?? globalThis.chrome;
const raf = (f) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(f) : setTimeout(f, 16));
const caf = (id) => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id));

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
}

export async function init() {
  if (new URLSearchParams(globalThis.location?.search ?? "").get("mode") === "popup") document.body.classList.add("popup");
  hydrateIcons();
  const $ = (id) => document.getElementById(id);
  const ui = {
    top: $("top"),
    provider: $("provider"),
    model: $("model"),
    modelCustom: $("model-custom"),
    btnModels: $("btn-models"),
    messages: $("messages"),
    panel: $("panel"),
    status: $("status"),
    form: $("composer"),
    input: $("input"),
    send: $("send"),
    btnTools: $("btn-tools"),
    btnWeb: $("btn-web"),
  };
  const services = createServices();
  const state = {
    cfg: await store.loadConfig(),
    conv: null,
    running: false,
    abort: null,
    toolViews: new Map(), // toolCallId -> vue de la carte d'outil
    pending: new Set(), // confirmations en attente
    stick: true,
    toolsReady: Promise.resolve(),
    panel: null,
    rateLimit: null, // { box, timer } : attente après un HTTP 429
    rlAuto: 0, // relances automatiques consécutives
  };

  const enabledProviders = () => state.cfg.providers.filter((p) => p.enabled !== false);
  const currentProvider = () => {
    const list = enabledProviders();
    return list.find((p) => p.id === ui.provider.value) ?? list[0] ?? null;
  };
  const openOptions = () => api?.runtime?.openOptionsPage?.();
  const setStatus = (t) => (ui.status.textContent = t || "");
  const patchSettings = async (p) => (state.cfg.settings = await store.saveSettings(p));

  // ---- Sélecteurs fournisseur / modèle ---------------------------------------------------------

  const CUSTOM = "__custom__";
  const getModel = () => (ui.model.value === CUSTOM ? "" : ui.model.value.trim());

  // Remplit la liste déroulante (modèles du fournisseur + modèle courant + saisie libre).
  function fillModelSelect(p, wanted) {
    clear(ui.model);
    const usableDefault = p.defaultModel && kindOf(p, p.defaultModel) === "chat" ? p.defaultModel : "";
    const all = [...new Set([wanted, usableDefault, ...chatModels(p)].filter(Boolean))];
    if (!all.length) ui.model.append(el("option", { value: "", text: "— aucun modèle —" }));
    for (const m of all) ui.model.append(el("option", { value: m, text: m }));
    ui.model.append(el("option", { value: CUSTOM, text: "Autre modèle…" }));
    ui.model.value = wanted || p.defaultModel || all[0] || "";
    ui.modelCustom.hidden = true;
  }

  // Modèle à proposer pour un fournisseur : le dernier utilisé, sinon son modèle par défaut, sinon le premier modèle
  // de génération de texte. Les modèles d'embeddings, de reranking, audio… ne sont jamais choisis automatiquement.
  function pickModel(p) {
    const cands = [state.cfg.settings.modelByProvider?.[p.id], p.defaultModel];
    return cands.find((m) => m && kindOf(p, m) === "chat") || chatModels(p)[0] || cands.find(Boolean) || "";
  }

  function renderModels(p) {
    if (!p) {
      clear(ui.model);
      ui.model.append(el("option", { value: "", text: "— aucun fournisseur —" }));
      return;
    }
    const fromConv = state.conv?.providerId === p.id && state.conv.model && kindOf(p, state.conv.model) === "chat" ? state.conv.model : "";
    fillModelSelect(p, fromConv || pickModel(p));
  }

  function renderSelectors() {
    if (document.activeElement === ui.model || !ui.modelCustom.hidden) return; // ne pas écraser un choix en cours
    const list = enabledProviders();
    clear(ui.provider);
    for (const p of list) ui.provider.append(el("option", { value: p.id, text: p.name || p.baseUrl }));
    const wanted = state.conv?.providerId ?? state.cfg.settings.activeProviderId;
    const active = list.find((p) => p.id === wanted) ?? list[0];
    if (active) ui.provider.value = active.id;
    renderModels(active);
  }

  // Interroge l'API (/models) et met à jour la liste mémorisée du fournisseur.
  async function fetchModels(p, { quiet = false } = {}) {
    if (!p?.baseUrl) return;
    try {
      const detailed = await listModelsDetailed(p);
      const models = detailed.map((m) => m.id);
      const modelKinds = Object.fromEntries(detailed.map((m) => [m.id, m.kind]));
      const cfg = await store.loadConfig();
      state.cfg.providers = cfg.providers.map((x) => (x.id === p.id ? { ...x, models, modelKinds } : x));
      await store.saveProviders(state.cfg.providers);
      if (currentProvider()?.id === p.id && ui.modelCustom.hidden) {
        const keep = getModel();
        const fresh = state.cfg.providers.find((x) => x.id === p.id) ?? { ...p, models };
        fillModelSelect(fresh, keep && kindOf(fresh, keep) === "chat" ? keep : pickModel(fresh));
      }
      if (!quiet) setStatus(`${models.length} modèle(s) disponible(s).`);
      return models;
    } catch (e) {
      if (!quiet) notice(describeError(e, p), "warn");
    }
  }

  const refreshModelsIfNeeded = (p) => (!p || p.models?.length ? undefined : fetchModels(p, { quiet: true }));

  async function commitModel(m) {
    const p = currentProvider();
    if (!p) return;
    if (state.conv) {
      state.conv.providerId = p.id;
      state.conv.model = m;
    }
    await patchSettings({ activeModel: m, modelByProvider: { ...state.cfg.settings.modelByProvider, [p.id]: m } });
  }

  // Modèle à proposer pour un fournisseur : celui de la conversation, sinon le dernier utilisé, sinon le défaut.
  const rememberedModel = (p) => (state.conv?.providerId === p.id && state.conv.model && kindOf(p, state.conv.model) === "chat" && state.conv.model) || pickModel(p);

  // Choix d'un fournisseur : la conversation et les réglages sont mis à jour AVANT tout nouveau rendu
  // (sinon l'ancien fournisseur de la conversation était ré-affiché), puis la liste de modèles est celle du
  // nouveau fournisseur, rechargée depuis son API si on ne la connaît pas encore.
  ui.provider.addEventListener("change", () => {
    const p = currentProvider();
    if (!p) return;
    const needFetch = !p.models?.length && !!p.baseUrl;
    // La demande d'autorisation doit partir de façon synchrone depuis le changement.
    const perm =
      needFetch && api?.permissions?.request
        ? Promise.resolve(api.permissions.request({ origins: [originPattern(p.baseUrl)] })).catch(() => false)
        : Promise.resolve(true);
    const model = rememberedModel(p);
    if (state.conv) {
      state.conv.providerId = p.id;
      state.conv.model = model;
    }
    ui.modelCustom.hidden = true;
    renderModels(p);
    setStatus(needFetch ? "Chargement des modèles…" : `${p.name || p.baseUrl} : ${chatModels(p).length} modèle(s).`);
    if (state.conv?.messages.length) save();
    patchSettings({ activeProviderId: p.id, activeModel: model });
    if (needFetch) {
      perm.then((ok) => {
        if (ok === false) {
          setStatus("");
          return notice("Autorisation d'accès au serveur refusée : impossible de charger les modèles (saisie libre possible).", "warn");
        }
        return fetchModels(p);
      });
    }
  });
  ui.model.addEventListener("change", async () => {
    if (ui.model.value === CUSTOM) {
      ui.modelCustom.hidden = false;
      ui.modelCustom.value = "";
      ui.modelCustom.focus();
      return;
    }
    ui.modelCustom.hidden = true;
    await commitModel(ui.model.value);
  });
  ui.modelCustom.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      ui.modelCustom.hidden = true;
      renderModels(currentProvider());
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = ui.modelCustom.value.trim();
      const p = currentProvider();
      if (!m || !p) return;
      fillModelSelect(p, m);
      await commitModel(m);
    }
  });
  ui.btnModels.addEventListener("click", () => {
    const p = currentProvider();
    if (!p) return openOptions();
    // La demande de permission doit partir de façon synchrone depuis le clic.
    const perm = api?.permissions?.request
      ? Promise.resolve(api.permissions.request({ origins: [originPattern(p.baseUrl)] })).catch(() => false)
      : Promise.resolve(true);
    ui.btnModels.disabled = true;
    setStatus("Chargement des modèles…");
    perm
      .then((ok) => (ok === false ? notice("Autorisation d'accès au serveur refusée.", "warn") : fetchModels(p)))
      .finally(() => (ui.btnModels.disabled = false));
  });

  // ---- Affichage des messages -------------------------------------------------------------------

  const nearBottom = () => ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 80;
  ui.messages.addEventListener("scroll", () => (state.stick = nearBottom()));
  const scrollDown = () => {
    if (state.stick) ui.messages.scrollTop = ui.messages.scrollHeight;
  };

  ui.messages.addEventListener("click", async (e) => {
    const btn = e.target.closest?.(".copy-btn");
    if (!btn) return;
    await copyText(btn.closest(".codeblock")?.querySelector("code")?.textContent ?? "");
    btn.textContent = "Copié";
    setTimeout(() => (btn.textContent = "Copier"), 1200);
  });

  function notice(text, kind = "") {
    const n = el("div", { class: `notice ${kind}` }, text);
    ui.messages.append(n);
    scrollDown();
    return n;
  }

  function showError(message, retry) {
    const box = el("div", { class: "error", role: "alert" }, el("div", {}, message));
    if (retry) box.append(el("button", { class: "btn small", type: "button", onclick: () => (box.remove(), retry()) }, "Réessayer"));
    ui.messages.append(box);
    scrollDown();
  }

  // ---- Limite de débit (HTTP 429) : attente, puis relance proposée -----------------------------------

  function clearRateLimit() {
    if (!state.rateLimit) return;
    clearInterval(state.rateLimit.timer);
    state.rateLimit.box.remove();
    state.rateLimit = null;
  }

  function showRateLimit(err, provider) {
    clearRateLimit();
    const s = state.cfg.settings;
    const configured = Math.max(1, Number(s.rateLimitWaitSec) || 180) * 1000;
    const serverAsked = Math.min(err.retryAfterMs || 0, 3600_000);
    const waitMs = Math.max(configured, serverAsked);
    const until = Date.now() + waitMs;
    const fmt = (ms) => {
      const t = Math.ceil(ms / 1000);
      return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    };
    const countdown = el("div", { class: "rl-count" });
    const go = el("button", { class: "btn small primary", type: "button" }, "Relancer maintenant");
    const cancel = el("button", { class: "btn small", type: "button" }, "Annuler");
    const box = el(
      "div",
      { class: "notice warn ratelimit", role: "status" },
      el("div", {}, `Limite de requêtes atteinte${provider?.name ? ` chez ${provider.name}` : ""} (HTTP 429). ${serverAsked > configured ? `Le serveur demande d'attendre ${fmt(serverAsked)}.` : ""}`.trim()),
      countdown,
      el("div", { style: "display:flex;gap:6px;margin-top:6px" }, go, cancel)
    );
    const rl = { box, timer: 0 };
    state.rateLimit = rl;
    const fire = () => {
      clearRateLimit();
      retryTurn();
    };
    const tick = () => {
      const left = until - Date.now();
      if (left > 0) {
        countdown.textContent = `Mise en attente : relance possible dans ${fmt(left)}.`;
        return;
      }
      clearInterval(rl.timer);
      if (s.rateLimitAutoRetry && state.rlAuto < 3) {
        state.rlAuto++;
        countdown.textContent = "Délai écoulé : relance automatique…";
        return fire();
      }
      countdown.textContent = "Délai écoulé. Vous pouvez relancer la question.";
      go.textContent = "Relancer";
    };
    go.addEventListener("click", fire);
    cancel.addEventListener("click", clearRateLimit);
    ui.messages.append(box);
    tick();
    rl.timer = setInterval(tick, 1000);
    scrollDown();
  }

  function renderWelcome() {
    clearRateLimit();
    clear(ui.messages);
    const noProvider = enabledProviders().length === 0;
    ui.messages.append(
      el(
        "div",
        { class: "welcome" },
        el("h2", {}, noProvider ? "Bienvenue" : "Comment puis-je vous aider ?"),
        el("p", {}, noProvider ? "Ajoutez d'abord un fournisseur IA : URL de l'API et token." : "Posez une question. Les outils MCP et les bases RAG se gèrent depuis le bouton « Outils »."),
        noProvider ? el("button", { class: "btn primary", type: "button", onclick: openOptions }, "Configurer un fournisseur") : null
      )
    );
  }

  function userBubble(msg) {
    const node = el("div", { class: "msg user" }, el("div", { class: "bubble" }, msg.content));
    ui.messages.append(node);
    scrollDown();
    return node;
  }

  function toolCard(tc) {
    const def = services.registry.list().find((d) => d.wireName === tc.name);
    const label = def ? `${def.sourceName} · ${def.name}` : tc.name;
    const status = el("span", { class: "tc-status pending" }, "en attente");
    const hasArgs = tc.arguments && Object.keys(tc.arguments).length;
    const approval = el("div", { class: "tc-approval", hidden: true });
    const resultLabel = el("div", { class: "tc-label", hidden: true }, "Résultat");
    const result = el("pre", { class: "tc-result", hidden: true });
    const root = el(
      "details",
      { class: "toolcard" },
      el("summary", {}, icon("tool", 14), el("span", { class: "tc-name", title: label }, label), status),
      approval,
      el("div", { class: "tc-label" }, "Arguments"),
      el("pre", { class: "tc-args" }, hasArgs ? JSON.stringify(tc.arguments, null, 2) : "(aucun argument)"),
      resultLabel,
      result
    );
    const view = {
      root,
      status: "pending",
      setStatus(kind, text) {
        view.status = kind;
        status.className = `tc-status ${kind}`;
        status.textContent = text;
      },
      setResult(text, isError) {
        const shown = text.length > 4000 ? text.slice(0, 4000) + "\n[… affichage tronqué]" : text;
        result.textContent = shown;
        result.hidden = resultLabel.hidden = false;
        if (/^L'utilisateur a refusé/.test(text)) view.setStatus("error", "refusé");
        else if (/^Annulé/.test(text)) view.setStatus("error", "annulé");
        else view.setStatus(isError ? "error" : "ok", isError ? "erreur" : "terminé");
      },
      ask() {
        return new Promise((resolve) => {
          const entry = { cancel: () => finish("deny") };
          const finish = (decision) => {
            if (!state.pending.delete(entry)) return;
            approval.hidden = true;
            if (decision === "deny") view.setStatus("error", "refusé");
            else view.setStatus("running", "autorisé");
            resolve(decision);
          };
          state.pending.add(entry);
          root.open = true;
          approval.hidden = false;
          clear(approval).append(
            el("div", { class: "tc-ask" }, "Autoriser l'exécution de cet outil ?"),
            el(
              "div",
              { class: "tc-buttons" },
              el("button", { class: "btn primary small", type: "button", onclick: () => finish("allow") }, "Autoriser"),
              el("button", { class: "btn small", type: "button", title: "Ne plus demander pour cet outil", onclick: () => finish("always") }, "Toujours autoriser"),
              el("button", { class: "btn danger small", type: "button", onclick: () => finish("deny") }, "Refuser")
            )
          );
          view.setStatus("pending", "confirmation requise");
          scrollDown();
        });
      },
    };
    state.toolViews.set(tc.id, view);
    return view;
  }

  function assistantView() {
    const reasoningBody = el("div", { class: "reasoning-body" });
    const reasoningBox = el("details", { class: "reasoning", hidden: true }, el("summary", {}, "Raisonnement"), reasoningBody);
    const body = el("div", { class: "bubble md" });
    const calls = el("div", { class: "toolcalls" });
    const actions = el("div", { class: "msg-actions" });
    const root = el("div", { class: "msg assistant empty" }, reasoningBox, body, calls, actions);
    ui.messages.append(root);
    let text = "";
    let reasoning = "";
    let frame = 0;
    let live = true;

    const paint = () => {
      frame = 0;
      const split = splitThink(text);
      const r = [reasoning, split.reasoning].filter(Boolean).join("\n\n");
      if (r) {
        reasoningBox.hidden = false;
        reasoningBody.textContent = r;
      }
      body.replaceChildren(renderMarkdown(split.text, document));
      body.classList.toggle("typing", live && !!split.text);
      root.classList.toggle("empty", !split.text && !r && !calls.children.length);
      scrollDown();
    };
    const schedule = () => {
      if (!frame) frame = raf(paint);
    };

    const view = {
      root,
      get text() {
        return splitThink(text).text;
      },
      appendText(d) {
        text += d;
        schedule();
      },
      appendReasoning(d) {
        reasoning += d;
        schedule();
      },
      set(msg) {
        text = msg.content || "";
        reasoning = msg.reasoning || "";
        paint();
      },
      addToolCalls(tcs) {
        for (const tc of tcs) calls.append(toolCard(tc).root);
        paint();
      },
      end(msg) {
        live = false;
        if (msg) {
          text = msg.content ?? text;
          reasoning = msg.reasoning ?? reasoning;
        }
        if (frame) caf(frame);
        paint();
        actions.append(
          el("button", { class: "btn small", type: "button", title: "Copier la réponse", onclick: () => copyText(view.text) }, icon("copy", 13), "Copier")
        );
      },
    };
    return view;
  }

  function refreshActions() {
    for (const b of ui.messages.querySelectorAll(".regen")) b.remove();
    if (state.running) return;
    const all = ui.messages.querySelectorAll(".msg.assistant .msg-actions");
    const last = all[all.length - 1];
    if (last) last.append(el("button", { class: "btn small regen", type: "button", title: "Régénérer la réponse", onclick: regenerate }, icon("refresh", 13), "Régénérer"));
  }

  function renderConversation() {
    clearRateLimit();
    clear(ui.messages);
    state.toolViews.clear();
    const msgs = state.conv?.messages ?? [];
    if (!msgs.length) return renderWelcome();
    for (const m of msgs) {
      if (m.role === "user") userBubble(m);
      else if (m.role === "assistant") {
        const v = assistantView();
        v.set(m);
        if (m.toolCalls?.length) v.addToolCalls(m.toolCalls);
        v.end(m);
      } else if (m.role === "tool") state.toolViews.get(m.toolCallId)?.setResult(m.content, m.isError);
    }
    for (const v of state.toolViews.values()) if (v.status === "pending") v.setStatus("error", "interrompu");
    refreshActions();
    state.stick = true;
    scrollDown();
  }

  // ---- Persistance --------------------------------------------------------------------------------

  let saving = Promise.resolve();
  const save = () =>
    (saving = saving
      .then(async () => {
        if (!state.conv) return;
        await store.saveConversation(state.conv);
        await store.setLastConversationId(state.conv.id);
      })
      .catch((e) => console.warn("Sauvegarde impossible", e)));

  // ---- Exécution d'un tour -----------------------------------------------------------------------

  let current = null;
  function onEvent(ev) {
    switch (ev.type) {
      case "assistant-start":
        current = assistantView();
        break;
      case "text":
        current?.appendText(ev.delta);
        break;
      case "reasoning":
        current?.appendReasoning(ev.delta);
        break;
      case "assistant-end": {
        const m = ev.message;
        if (current) {
          if (m.toolCalls?.length) current.addToolCalls(m.toolCalls);
          current.end(m);
          if (!m.content && !m.toolCalls?.length && !m.reasoning) current.root.remove();
        }
        save();
        break;
      }
      case "tool-start":
        state.toolViews.get(ev.toolCall.id)?.setStatus("running", "exécution…");
        setStatus(`Outil en cours : ${ev.def?.name ?? ev.toolCall.name}`);
        break;
      case "tool-result":
        state.toolViews.get(ev.message.toolCallId)?.setResult(ev.message.content, ev.message.isError);
        setStatus("Génération en cours…");
        save();
        break;
      case "sources": {
        const names = [...new Set(ev.results.map((r) => `${r.docName} (${r.collectionName})`))];
        notice(`Sources injectées : ${names.join(", ")}`);
        break;
      }
      case "warning":
        notice(ev.message, "warn");
        break;
      default:
        break;
    }
  }

  function requestApproval({ toolCall }) {
    const v = state.toolViews.get(toolCall.id);
    return v ? v.ask() : Promise.resolve("deny");
  }

  function setBusy(b) {
    state.running = b;
    clear(ui.send).append(icon(b ? "stop" : "send"), el("span", { class: "sr" }, b ? "Arrêter" : "Envoyer"));
    ui.send.title = b ? "Arrêter (Échap)" : "Envoyer (Entrée)";
    ui.send.classList.toggle("stop", b);
    setStatus(b ? "Génération en cours…" : "");
    if (b) for (const x of ui.messages.querySelectorAll(".regen")) x.remove();
  }

  function stop() {
    state.abort?.abort();
    for (const p of [...state.pending]) p.cancel();
  }

  async function runTurn(provider, model) {
    clearRateLimit();
    setBusy(true);
    state.abort = new AbortController();
    const settings = state.cfg.settings;
    const retrieve =
      settings.ragAutoInject && settings.ragCollectionIds.length
        ? (q) => services.ragSearch({ collectionIds: settings.ragCollectionIds, query: q, topK: settings.ragTopK })
        : null;
    try {
      await Promise.race([state.toolsReady, sleep(2500)]); // ne pas bloquer si un serveur MCP est lent
      await runAgent({
        provider,
        model,
        messages: state.conv.messages,
        settings,
        registry: services.registry,
        signal: state.abort.signal,
        emit: onEvent,
        requestApproval,
        onAlwaysAllow: async (key) => {
          await patchSettings({ approvedTools: [...new Set([...state.cfg.settings.approvedTools, key])] });
        },
        retrieve,
      });
    } catch (e) {
      if (e instanceof LLMError && e.status === 429) showRateLimit(e, provider);
      else showError(describeError(e, provider), retryTurn);
    } finally {
      state.abort = null;
      setBusy(false);
      refreshActions();
      await save();
    }
  }

  /** Relance le tour avec le fournisseur / modèle *actuels* (le token a pu être corrigé entre-temps). */
  async function retryTurn() {
    if (state.running || !state.conv) return;
    const provider = currentProvider();
    const model = getModel();
    if (!provider || !model) return notice("Choisissez un fournisseur et un modèle avant de réessayer.", "warn");
    await runTurn(provider, model);
  }

  async function send() {
    const text = ui.input.value.trim();
    if (!text || state.running) return;
    const provider = currentProvider();
    const model = getModel();
    if (!provider) return notice("Aucun fournisseur IA configuré : ouvrez les paramètres pour en ajouter un.", "warn");
    if (!model) return notice("Choisissez ou saisissez un modèle.", "warn");

    if (!state.conv) {
      state.conv = store.newConversation();
      clear(ui.messages);
    }
    state.conv.providerId = provider.id;
    state.conv.model = model;
    const msg = { role: "user", content: text, ts: Date.now() };
    state.conv.messages.push(msg);
    if (state.conv.messages.length === 1) state.conv.title = text.replace(/\s+/g, " ").slice(0, 60);
    ui.input.value = "";
    autosize();
    state.stick = true;
    state.rlAuto = 0;
    userBubble(msg);
    await save();
    await runTurn(provider, model);
  }

  async function regenerate() {
    if (state.running || !state.conv) return;
    const msgs = state.conv.messages;
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    msgs.length = idx + 1;
    renderConversation();
    await save();
    const provider = currentProvider();
    const model = getModel();
    if (provider && model) await runTurn(provider, model);
  }

  async function newChat() {
    if (state.running) return setStatus("Arrêtez d'abord la génération en cours.");
    state.conv = null;
    state.toolViews.clear();
    await store.setLastConversationId(null);
    renderWelcome();
    renderSelectors();
    closePanel();
    ui.input.focus();
  }

  async function openConversation(id) {
    if (state.running) return setStatus("Arrêtez d'abord la génération en cours.");
    const c = await store.loadConversation(id);
    if (!c) return;
    state.conv = c;
    await store.setLastConversationId(c.id);
    renderConversation();
    renderSelectors();
    closePanel();
  }

  // ---- Panneaux ---------------------------------------------------------------------------------------

  function positionPanel() {
    ui.panel.style.setProperty("--top-h", `${ui.top.offsetHeight}px`);
  }
  function closePanel() {
    state.panel = null;
    ui.panel.hidden = true;
    clear(ui.panel);
  }
  function openPanel(kind) {
    if (state.panel === kind) return closePanel();
    state.panel = kind;
    ui.panel.hidden = false;
    positionPanel();
    renderPanel();
  }
  async function renderPanel() {
    const kind = state.panel;
    const frag = document.createDocumentFragment();
    if (kind === "history") await buildHistory(frag);
    else if (kind === "tools") await buildTools(frag);
    if (state.panel === kind) clear(ui.panel).append(frag);
  }

  const panelHead = (title, ...extra) =>
    el("div", { class: "panel-head" }, el("h2", {}, title), ...extra, el("button", { class: "iconbtn", type: "button", title: "Fermer", onclick: closePanel }, icon("x")));

  async function buildHistory(frag) {
    const all = await store.listConversations();
    const search = el("input", { type: "search", placeholder: "Rechercher…", "aria-label": "Rechercher une conversation" });
    const list = el("div", { class: "conv-list" });
    let confirmAll = false;
    const clearBtn = el("button", { class: "btn danger small", type: "button" }, "Tout supprimer");
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      clear(list);
      const shown = all.filter((c) => !q || c.title.toLowerCase().includes(q));
      if (!shown.length) list.append(el("p", { class: "muted" }, all.length ? "Aucun résultat." : "Aucune conversation enregistrée."));
      for (const c of shown) {
        list.append(
          el(
            "div",
            { class: `conv${state.conv?.id === c.id ? " current" : ""}` },
            el(
              "button",
              { class: "conv-open", type: "button", onclick: () => openConversation(c.id) },
              el("span", { class: "conv-title" }, c.title || "Sans titre"),
              el("span", { class: "conv-date" }, new Date(c.updatedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))
            ),
            el(
              "button",
              {
                class: "iconbtn",
                type: "button",
                title: "Supprimer",
                onclick: async () => {
                  await store.deleteConversation(c.id);
                  all.splice(all.findIndex((x) => x.id === c.id), 1);
                  if (state.conv?.id === c.id && !state.running) await newChat(), openPanel("history");
                  else paint();
                },
              },
              icon("trash", 14)
            )
          )
        );
      }
      clearBtn.hidden = !all.length;
    };
    clearBtn.addEventListener("click", async () => {
      if (!confirmAll) {
        confirmAll = true;
        clearBtn.textContent = "Confirmer la suppression de tout ?";
        return;
      }
      await store.deleteAllConversations();
      all.length = 0;
      confirmAll = false;
      clearBtn.textContent = "Tout supprimer";
      if (!state.running) await newChat(), openPanel("history");
      else paint();
    });
    search.addEventListener("input", paint);
    paint();
    frag.append(panelHead("Historique"), search, list, el("div", { class: "section" }, clearBtn));
  }

  const checkbox = (label, checked, onChange, hint) =>
    el(
      "label",
      { class: "check" },
      el("input", { type: "checkbox", checked: !!checked, onchange: (e) => onChange(e.target.checked) }),
      el("span", {}, label, hint ? el("div", { class: "hint" }, hint) : null)
    );

  function enabledToolCount() {
    const s = state.cfg.settings;
    if (!s.toolsEnabled) return 0;
    const disabled = new Set(s.disabledTools);
    return services.registry.list().filter((t) => !disabled.has(t.approvalKey)).length;
  }
  function updateBadge() {
    const n = enabledToolCount();
    if (n) ui.btnTools.dataset.count = String(n);
    else delete ui.btnTools.dataset.count;
  }

  function updateWebBtn() {
    const on = !!state.cfg.settings.webSearchEnabled;
    ui.btnWeb.setAttribute("aria-pressed", String(on));
    ui.btnWeb.title = on ? "Recherche web activée (cliquer pour désactiver)" : "Recherche web désactivée (cliquer pour activer)";
  }

  function refreshTools(force = false) {
    state.toolsReady = services.registry
      .refresh({ force })
      .then(() => {
        updateBadge();
        if (state.panel === "tools") renderPanel();
      })
      .catch((e) => console.warn("Outils :", e));
    return state.toolsReady;
  }
  let refreshTimer = 0;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshTools(), 300);
  };

  async function buildTools(frag) {
    const s = state.cfg.settings;
    const reg = services.registry;
    const collections = await ragdb.listCollections();

    const refreshBtn = el("button", { class: "iconbtn", type: "button", title: "Reconnecter les serveurs et recharger les outils", onclick: () => refreshTools(true) }, icon("refresh"));
    frag.append(panelHead("Outils et connaissances", refreshBtn));

    frag.append(
      el(
        "div",
        { class: "section" },
        checkbox("Activer les outils", s.toolsEnabled, async (v) => (await patchSettings({ toolsEnabled: v }), updateBadge())),
        checkbox("Demander confirmation avant chaque exécution", s.confirmTools, (v) => patchSettings({ confirmTools: v }), "Recommandé : un outil peut agir sur vos données, et son résultat peut contenir des instructions malveillantes.")
      )
    );

    // Serveurs MCP et RAG distants
    const sec = el("div", { class: "section" }, el("h3", {}, "Serveurs MCP et RAG distants"));
    const statuses = reg.getStatus().filter((x) => x.type !== "rag");
    if (!statuses.length) sec.append(el("p", { class: "muted" }, "Aucun serveur actif. Ajoutez-en dans les paramètres."));
    const disabled = new Set(s.disabledTools);
    for (const st of statuses) {
      const box = el(
        "div",
        { class: "src" },
        el("div", { class: "src-head" }, el("span", { class: "grow", title: st.name }, st.name), el("span", { class: `badge ${st.ok ? "ok" : "error"}` }, st.ok ? `${st.toolCount} outil${st.toolCount > 1 ? "s" : ""}` : "erreur"))
      );
      if (!st.ok) box.append(el("div", { class: "err" }, st.error));
      for (const t of reg.list().filter((d) => d.sourceId === st.id)) {
        box.append(checkbox(t.name, !disabled.has(t.approvalKey), async (on) => {
          const set = new Set(state.cfg.settings.disabledTools);
          if (on) set.delete(t.approvalKey);
          else set.add(t.approvalKey);
          await patchSettings({ disabledTools: [...set] });
          updateBadge();
        }, t.description ? t.description.slice(0, 140) : ""));
      }
      sec.append(box);
    }
    frag.append(sec);

    // RAG local
    const rag = el("div", { class: "section" }, el("h3", {}, "Bases de connaissances locales"));
    if (!collections.length) rag.append(el("p", { class: "muted" }, "Aucune base. Créez-en une dans Paramètres > RAG."));
    for (const c of collections) {
      rag.append(
        checkbox(`${c.name} — ${c.docCount} doc., ${c.chunkCount} extraits${c.embedding ? " (embeddings)" : ""}`, s.ragCollectionIds.includes(c.id), async (on) => {
          const set = new Set(state.cfg.settings.ragCollectionIds);
          if (on) set.add(c.id);
          else set.delete(c.id);
          await patchSettings({ ragCollectionIds: [...set] });
          refreshTools();
        })
      );
    }
    if (collections.length) {
      rag.append(
        el("p", { class: "hint" }, "Les collections cochées sont proposées au modèle via l'outil « rag_search »."),
        checkbox("Injecter automatiquement les extraits pertinents", s.ragAutoInject, (v) => patchSettings({ ragAutoInject: v }), "La question est recherchée avant l'envoi, sans appel d'outil.")
      );
    }
    frag.append(rag);

    const approved = s.approvedTools.length;
    frag.append(
      el(
        "div",
        { class: "section" },
        el("h3", {}, "Autorisations mémorisées"),
        el("p", { class: "muted" }, approved ? `${approved} outil(s) autorisé(s) en permanence.` : "Aucune."),
        approved
          ? el("button", { class: "btn small", type: "button", onclick: async () => (await patchSettings({ approvedTools: [] }), renderPanel()) }, "Tout réinitialiser")
          : null,
        el("div", { class: "section" }, el("button", { class: "btn small", type: "button", onclick: openOptions }, "Ouvrir les paramètres"))
      )
    );
  }

  // ---- Saisie -----------------------------------------------------------------------------------------

  function autosize() {
    ui.input.style.height = "auto";
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, Math.round((globalThis.innerHeight || 600) * 0.4))}px`;
  }
  ui.input.addEventListener("input", autosize);
  ui.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ui.form.requestSubmit();
    }
  });
  ui.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.running) stop();
    else send();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.panel) closePanel();
    else if (state.running) stop();
  });

  $("btn-new").addEventListener("click", newChat);
  $("btn-history").addEventListener("click", () => openPanel("history"));
  $("btn-tools").addEventListener("click", () => openPanel("tools"));
  ui.btnWeb.addEventListener("click", () => {
    const s = state.cfg.settings;
    const turnOn = !s.webSearchEnabled;
    // La demande d'autorisation doit partir de façon synchrone depuis le clic.
    const perm =
      turnOn && api?.permissions?.request
        ? Promise.resolve(webOrigins(s).length ? api.permissions.request({ origins: webOrigins(s) }) : true).catch(() => false)
        : Promise.resolve(true);
    perm.then(async (ok) => {
      if (ok === false) return notice("Autorisation d'accès au web refusée : la recherche web reste désactivée.", "warn");
      await patchSettings(turnOn ? { webSearchEnabled: true, toolsEnabled: true } : { webSearchEnabled: false });
      updateWebBtn();
      setStatus(turnOn ? "Recherche web activée." : "Recherche web désactivée.");
      scheduleRefresh();
    });
  });
  $("btn-options").addEventListener("click", openOptions);
  $("btn-tab").addEventListener("click", () => api?.tabs?.create?.({ url: api.runtime.getURL("sidebar/sidebar.html") }));
  globalThis.addEventListener?.("resize", positionPanel);
  globalThis.addEventListener?.("pagehide", () => services.registry.close());

  store.onConfigChanged(async () => {
    state.cfg = await store.loadConfig();
    renderSelectors();
    updateBadge();
    updateWebBtn();
    scheduleRefresh();
    if (!state.conv && !state.running && !ui.messages.querySelector(".msg")) renderWelcome();
  });

  // ---- Démarrage ----------------------------------------------------------------------------------------

  setBusy(false);
  updateWebBtn();
  renderSelectors();
  const lastId = await store.getLastConversationId();
  const last = lastId ? await store.loadConversation(lastId) : null;
  if (last) {
    state.conv = last;
    renderConversation();
    renderSelectors();
  } else {
    renderWelcome();
  }
  refreshModelsIfNeeded(currentProvider());
  refreshTools();

  return { state, ui, services, send, stop, newChat, openPanel, refreshTools };
}

if (!globalThis.__AICHAT_NO_AUTOINIT__) init();
