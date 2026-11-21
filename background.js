// Script de fond (event page, Manifest V3). Volontairement minimal :
// toute la logique (chat, outils, RAG) vit dans les pages de l'extension.
const api = typeof browser !== "undefined" ? browser : chrome;

const openInTab = () => api.tabs.create({ url: api.runtime.getURL("sidebar/sidebar.html") });

// Mode d'ouverture choisi dans les paramètres : "sidebar" (défaut) ou "popup".
// En mode popup, Firefox ouvre la page dans une fenêtre flottante et n'envoie plus action.onClicked.
async function applyOpenMode() {
  try {
    const { settings } = await api.storage.local.get("settings");
    const popup = settings?.openMode === "popup" ? "sidebar/sidebar.html?mode=popup" : "";
    await api.action.setPopup({ popup });
  } catch {
    /* sans importance : le mode barre latérale reste actif */
  }
}
applyOpenMode(); // à chaque réveil de l'event page
api.runtime.onStartup.addListener(applyOpenMode);
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) applyOpenMode();
});

// Clic sur le bouton de la barre d'outils (mode barre latérale) : ouvre / ferme la barre latérale.
// Sans barre latérale (Firefox pour Android), le chat s'ouvre dans un onglet.
api.action.onClicked.addListener(async () => {
  if (!api.sidebarAction) return openInTab();
  try {
    await api.sidebarAction.toggle();
  } catch {
    try {
      await api.sidebarAction.open();
    } catch {
      openInTab();
    }
  }
});

// Première installation : ouvre la page de configuration (fournisseurs, tokens…).
api.runtime.onInstalled.addListener(({ reason }) => {
  applyOpenMode();
  if (reason === "install") api.runtime.openOptionsPage();
});
