# AI Chat Sidebar — extension Firefox

Chat avec des LLM dans la barre latérale de Firefox, avec **outils MCP**, **RAG** et **configuration libre des API** (URL + token).

> L'objectif est de tester rapidement l'usage des serveurs MCP et collections de documents (RAG) afin de valider des cas d'usage depuis l'environnement d'un utilisateur (ici depuis un navigateur firefox).


- **Chat** en streaming (Markdown, blocs de code copiables, raisonnement repliable), historique des conversations, arrêt / régénération.
- **Fournisseurs IA** : tout service *compatible OpenAI* (OpenAI, Mistral, Groq, OpenRouter, Gemini, Ollama, LM Studio, vLLM, LiteLLM…) et l'API **Anthropic**. Vous saisissez l'URL de base et le token ; plusieurs fournisseurs coexistent.
- **Recherche web** : le modèle peut chercher sur Internet (`web_search`) et lire des pages (`web_fetch`), puis citer ses sources. Moteurs : DuckDuckGo (sans clé), SearXNG (votre instance), Brave Search (clé API). Bouton 🌐 dans la barre latérale pour l'activer/désactiver.
- **Limite de requêtes (HTTP 429)** : si l'API répond 429, le chat se met en attente (3 minutes par défaut, réglable) avec compte à rebours, puis propose de relancer la question ; relance automatique optionnelle.
- **Popup ou barre latérale** : le bouton de la barre d'outils ouvre le chat dans une fenêtre popup ou dans la barre latérale (réglage dans Paramètres → Général → Affichage).
- **Outils MCP** : serveurs distants en *Streamable HTTP* (repli automatique sur l'ancien transport HTTP+SSE).
- **RAG** : collections locales (import de fichiers texte/Markdown/HTML/CSV/JSON/code, recherche hybride BM25 + embeddings) et services RAG HTTP externes. Le modèle les interroge via un outil, ou les extraits sont injectés automatiquement.

## Installation

Prérequis : Firefox ≥ 140 (bureau).

**Test rapide (temporaire)** : `about:debugging#/runtime/this-firefox` → « Charger un module complémentaire temporaire… » → sélectionner `manifest.json`.

**Avec web-ext** : `npm install` puis `npm start` (lance un Firefox de développement avec l'extension).

**Paquet** : `npm run build` produit `dist/*.zip`. Pour une installation permanente il faut le faire signer (AMO, « non répertorié » suffit pour un usage personnel).
Avant de publier, changez l'identifiant `browser_specific_settings.gecko.id` dans `manifest.json` et relisez `data_collection_permissions`.

Seuls les modèles de **génération de texte** sont proposés pour discuter : les modèles d'embeddings, de reranking, audio ou image sont repérés (par le champ `type` de l'API quand il existe, sinon par leur nom) et exclus de la liste et du choix automatique ; les embeddings se choisissent dans l'onglet RAG. Dans la barre latérale, changer de **fournisseur** recharge aussitôt la liste des modèles de ce fournisseur (interrogée sur son API si elle n'est pas encore connue) et reprend le dernier modèle utilisé avec lui. La liste déroulante **Modèle** propose les modèles du fournisseur choisi ; le bouton ↻ la met à jour depuis l'API (`/models`), et « Autre modèle… » permet de saisir un nom à la main.

Le bouton de la barre d'outils (ou `Alt+Maj+Y`) ouvre la barre latérale. À la première installation, la page de paramètres s'ouvre.

## Configuration

### 1. Fournisseur IA (Paramètres → Fournisseurs IA)

« Ajouter un fournisseur », choisissez un préréglage (ou « Personnalisé »), renseignez le token, puis **« Tester et charger les modèles »**. Firefox demandera l'autorisation d'accéder à ce serveur : c'est nécessaire pour que les requêtes partent (l'extension ne demande aucun accès réseau à l'installation).

| Service | Type | URL de base |
|---|---|---|
| OpenAI | compatible OpenAI | `https://api.openai.com/v1` |
| Anthropic | Anthropic | `https://api.anthropic.com` |
| Mistral | compatible OpenAI | `https://api.mistral.ai/v1` |
| Groq | compatible OpenAI | `https://api.groq.com/openai/v1` |
| OpenRouter | compatible OpenAI | `https://openrouter.ai/api/v1` |
| Ollama | compatible OpenAI | `http://localhost:11434/v1` |
| LM Studio | compatible OpenAI | `http://localhost:1234/v1` |

Les URLs sont celles des préréglages ; vérifiez-les dans la documentation de votre fournisseur si une requête échoue.

**Ollama** : s'il répond `403`, démarrez-le avec `OLLAMA_ORIGINS="moz-extension://*"` puis redémarrez le service.
Des en-têtes HTTP supplémentaires peuvent être ajoutés par fournisseur (organisation, version d'API…).

### 1 bis. Recherche web (Paramètres → Général → Recherche web)

Cochez « Activer la recherche web », choisissez le moteur et cliquez sur **« Tester la recherche »**. Firefox demande l'accès aux sites : « tous les sites » si la lecture de pages (`web_fetch`) est autorisée, sinon uniquement le moteur de recherche. Le bouton 🌐 de la barre latérale active/désactive rapidement les outils web.

- **DuckDuckGo** : aucune clé, mais le service peut demander une vérification en cas d'usage intensif.
- **SearXNG** : indiquez l'URL de l'instance ; le format JSON doit être activé (`search.formats: [html, json]`).
- **Brave Search** : clé API requise.
- `web_fetch` refuse les adresses locales/privées (localhost, 192.168.x.x, `.local`, métadonnées cloud…) et les redirections vers elles. Chaque appel reste soumis à confirmation : une page lue peut contenir des instructions malveillantes, et l'URL demandée est visible dans la carte d'outil avant exécution.
- Les requêtes de recherche et les pages lues transitent par le moteur / les sites concernés, pas par un serveur de l'extension.

### 1 ter. Limite de requêtes HTTP 429 (Paramètres → Général)

Quand l'API renvoie `429`, le message n'est pas perdu : une boîte « Mise en attente » affiche un compte à rebours (défaut **180 s**, réglable de 1 à 3600 s). Si le serveur envoie un en-tête `Retry-After` plus long, il est respecté (plafonné à 1 h). À la fin du délai, le bouton **Relancer** reprend la même question avec le fournisseur et le modèle alors sélectionnés ; **Relancer maintenant** passe outre l'attente et **Annuler** abandonne. L'option « Relancer automatiquement » le fait seule (3 fois au plus). Le délai est ignoré si vous envoyez un autre message ou changez de conversation. Le compte à rebours s'arrête si la barre latérale ou le popup est fermé.

### 2. Outils MCP (Paramètres → Outils MCP)

Ajoutez l'URL du serveur (ex. `https://exemple.org/mcp`) et, si besoin, un token (envoyé en `Authorization: Bearer …`) ou des en-têtes. **« Tester la connexion »** liste les outils découverts.
Une extension ne peut pas lancer de processus local : un serveur MCP « stdio » doit être exposé via un pont HTTP.

### 3. RAG (Paramètres → RAG)

- **Collections locales** : créez une collection, importez des fichiers ou collez du texte. Les PDF et documents Office ne sont pas lus (convertissez-les en texte).
- **Import ChromaDB** : sélectionnez la base `chroma.sqlite3` (dossier de persistance de Chroma ≥ 0.4, jusqu'à 500 Mo) ou un export JSON/JSONL (`collection.get(include=["documents","metadatas"])`, liste d'objets `{id, document, metadata}`). Les enregistrements sont regroupés en un document par source (métadonnée `source`, `file_path`, `url`…), remis dans l'ordre (`chunk_index`…) puis ré-indexés avec les paramètres de la collection. **Les vecteurs de Chroma ne sont pas repris** : ils proviennent d'un autre modèle, or les questions doivent être encodées par le même modèle que les extraits. Si la base est en mode WAL, fermez Chroma avant l'import pour que tout soit écrit dans le fichier.
- **Embeddings** (optionnel) : choisissez un fournisseur compatible OpenAI et un modèle d'embeddings. Sans cela, la recherche est lexicale (BM25) ; avec, elle devient hybride. Le modèle est mémorisé dans chaque collection à sa création ; « Réindexer » permet de changer.
- **Services RAG distants** : URL en POST, modèle de corps JSON (`{{query}}`, `{{top_k}}`), chemin du résultat. Ils deviennent des outils au même titre que MCP.

Dans la barre latérale, le bouton **Outils** permet d'activer/désactiver chaque outil, de cocher les collections utilisables et d'activer l'injection automatique des extraits.

## Sécurité et confidentialité

- L'extension n'a **pas de serveur propre** : vos messages, extraits RAG et résultats d'outils ne vont qu'aux URLs que vous configurez.
- Les **tokens sont stockés en clair** dans le stockage local de l'extension (profil Firefox) et envoyés uniquement à leur URL. Utilisez des clés révocables à portée limitée. L'export de configuration exclut les tokens par défaut.
- **Confirmation avant chaque exécution d'outil** (activée par défaut ; « Toujours autoriser » par outil). Le résultat d'un outil ou un document peut contenir des instructions malveillantes (*prompt injection*) : un prompt système demande au modèle de les traiter comme des données, mais la confirmation reste la vraie protection.
- Le rendu Markdown ne passe jamais par `innerHTML` ; seuls les liens `http(s)`/`mailto` sont cliquables et les images distantes ne sont jamais chargées (pas de pixel espion).
- Pour MCP en HTTP+SSE, l'endpoint annoncé par le serveur doit rester sur la même origine (sinon le token pourrait fuiter).
- Une URL `http://` vers un hôte non local déclenche un avertissement.

## Architecture

```
manifest.json            MV3, sidebar_action, permissions optionnelles
background.js            bouton de barre d'outils
lib/llm.js               clients OpenAI-compatible / Anthropic (streaming, tools, modèles, embeddings)
lib/mcp.js               client MCP (Streamable HTTP + HTTP/SSE)
lib/tools.js             registre d'outils : MCP, rag_search local, RAG HTTP
lib/agent.js             boucle LLM ↔ outils, confirmations, annulation
lib/web.js               recherche web (DuckDuckGo, SearXNG, Brave) et lecture de pages
lib/chroma.js            import ChromaDB (lecteur SQLite intégré, export JSON)
lib/rag.js, ragdb.js     découpage, BM25, cosinus, RRF ; stockage IndexedDB
lib/markdown.js, dom.js  rendu sûr, helpers DOM
sidebar/                 interface de chat
options/                 paramètres
tests/                   100 tests (node:test)
```

## Développement

```
npm install
npm test        # sse, llm, mcp, rag, agent, markdown, sidebar (jsdom), options (jsdom)
npm run lint    # web-ext lint
```

Les tests utilisent de faux serveurs HTTP locaux (OpenAI, Anthropic, MCP Streamable/SSE, embeddings, RAG), `fake-indexeddb` et `jsdom` : ils exécutent les vraies pages `sidebar.html` / `options.html`. **Ils ne remplacent pas un essai dans un vrai Firefox** (permissions, rendu CSS, comportement de la barre latérale) : ces points n'ont pas été vérifiés automatiquement.

## Limites connues

- Pas de PDF / Office en entrée RAG ; pas de pièces jointes ni d'images dans le chat.
- Le streaming s'arrête si la barre latérale ou le popup est fermé pendant une réponse (le popup se ferme dès qu'on clique ailleurs : préférez la barre latérale ou « Ouvrir dans un onglet » pour les réponses longues).
- La recherche web passe par les outils : le modèle doit supporter l'appel d'outils. Les outils de recherche intégrés des fournisseurs (OpenAI, Anthropic) ne sont pas utilisés.
- MCP : outils uniquement (pas de ressources, prompts ni sampling).
- Les recherches RAG chargent la collection en mémoire : prévu pour quelques milliers d'extraits, pas pour des corpus massifs.
- Firefox pour Android : le chat s'ouvre dans un onglet (non testé).

**Réalisé avec claude IA**.