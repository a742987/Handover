[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | **Français** | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

> Les traductions communautaires peuvent être en retard sur le README anglais pour les étapes d'installation et le flux de données.

# Handover

> **Quand un·e développeur·se part, son savoir ne devrait pas partir avec lui.**
> Pointez Handover vers le nom d'utilisateur d'un ingénieur sur le départ, et il lira tout ce qu'il ou elle a jamais commité, relu et défendu — puis produira un **Livre de Passation** (Handover Book) relié et adossé aux preuves, pour la personne qui prend la relève.

Une seule commande. S'exécute localement. La synthèse par un LLM distant est optionnelle (`--use-llm` ou `HANDOVER_LLM=1`) ; sans elle, rien ne quitte la machine et les chapitres 4-6 sont générés de façon déterministe.

```bash
handover gen <username> --repo owner/name
```

---

## Pourquoi

`git blame` vous dit *qui* a écrit une ligne. Il ne peut pas vous dire *pourquoi* — ni quels modules vont perdre en silence leur unique relecteur, ni quelle décision de conception « bizarre » est en réalité porteuse de tout l'édifice. Les wikis dépendent de gens qui écrivent volontairement, et les entretiens de départ commencent après l'annonce de la démission et se terminent avant que le savoir ait été transmis.

Handover couvre les pertes implicites que rien d'autre ne couvre :

1. **Panorama du code** — chaque module qu'il ou elle a touché, son état et son historique
2. **Inventaire du savoir implicite** — les modules dont il ou elle était l'*unique* auteur ou l'*unique* relecteur
3. **Top 5 des risques** — « ce qui casse quand cette personne part », classé et noté, chaque point avec sa chaîne de preuves
4. **Archéologie des décisions** — « pourquoi on a choisi ça à l'époque », en citant les vrais débats de PR et d'issues
5. **Le parcours des 30 jours** — le plan d'apprentissage de la personne qui succède
6. **Questions et réponses en brouillon** — ce qu'il faut demander avant le dernier jour, plus les réponses que la personne qui part a elle-même enregistrées

## Démarrage rapide

Le chemin le plus court — une seule commande, sans cloner le dépôt (nécessite Node ≥ 22.13, livré avec SQLite intégré — pas de compilation native) :

```bash
npm install -g handover-book

# depuis GitHub (nécessite un token pour des limites de requêtes raisonnables) :
export GITHUB_TOKEN=ghp_...
handover gen <username> --repo owner/name --html

# ou sans token et sans réseau — lisez directement les clones locaux de la personne :
handover gen <username> --git-dir ~/work/api --git-dir ~/work/web
```

Le résultat atterrit dans `handover-data/` :

- `handover-data/<username>.db` — l'index SQLite local (un fichier par personne ; les exécutions suivantes sont incrémentales et quasi instantanées)
- `handover-data/handover-book-<username>.md` — le livre relié (avec `--html`, un jumeau HTML monofichier prêt à imprimer ; l'impression depuis le navigateur vous donne le PDF)

Vous préférez l'exécuter depuis les sources ? `git clone https://github.com/a742987/Handover && cd Handover && npm install && npm run dev -- gen <username> --repo owner/name`.

### Commandes

| Commande | Ce qu'elle fait |
|---|---|
| `gen <username> -r owner/name` | collecter → analyser → générer le livre complet |
| `collect <username> -r owner/name [-d dir]` | indexer uniquement l'historique (les commits, PRs, reviews et issues déjà présents dans l'index sont ignorés) |
| `capture <username>` | s'asseoir avec la personne qui part et enregistrer ses propres réponses ; elles sont reliées dans le chapitre 6 (`--answers q.json` pour les agents et les scripts) |
| `risk <username> [--json]` | afficher le Top 5 des risques à partir de l'index local |
| `bus-factor <username>` | vue d'équipe : quels modules ne reçoivent des commits que d'une seule personne, avec fusion de CODEOWNERS quand le dépôt en a un |
| `gate <username> --files changed.txt` | contrôle CI : ce jeu de changements touche-t-il des modules à propriétaire unique ? (`--comment`, `--fail-on-match`, `--repo owner/name` pour circonscrire un index multi-dépôts ; voir [`examples/sole-owner-gate-action.yml`](examples/sole-owner-gate-action.yml)) |
| `verify <username>` | contrôle d'existence des citations : chaque référence citée dans le livre généré doit exister dans l'index (exit 1 s'il en manque — compatible CI, `--json` pour les machines) |
| `render <username>` | régénérer le livre à partir de l'index, sans accès à GitHub (les chapitres 4-6 n'appellent le fournisseur LLM que si `--use-llm` est passé et qu'une clé API est configurée ; passez `-r` pour remplacer les dépôts enregistrés dans l'index) |

Flags courants : `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>`, `--data-dir <dir>`, `--refresh` (récupère à nouveau ce qui est déjà indexé), `--html` (jumeau HTML prêt à imprimer), `--redact` (supprime les formats de secrets connus du résumé destiné au LLM et du livre ; **activé par défaut**), `--use-llm` / `HANDOVER_LLM=1` ([README.md#llm-providers](README.md#llm-providers), [.env.example](.env.example)), `--no-redact` (conserve le texte du dépôt tel quel, aussi `HANDOVER_NO_REDACT=1`), `--no-llm` (saute la synthèse LLM même quand une clé est configurée — uniquement des chapitres déterministes, rien ne quitte la machine ; aussi `HANDOVER_NO_LLM=1`). `gen` et `collect` acceptent `--author <identity>` pour faire correspondre le nom/courriel de la personne qui part dans les clones locaux.

### Fournisseurs de LLM

Les chapitres 1 à 3 sont calculés de façon déterministe à partir de l'index — ils fonctionnent toujours, avec ou sans clé d'API. Les chapitres 4 à 6 sont synthétisés par un LLM ; **sans clé, ils retombent sur des résumés déterministes** au lieu d'échouer.

- **Anthropic** — définissez `ANTHROPIC_API_KEY` (fournisseur par défaut)
- **OpenAI** — définissez `OPENAI_API_KEY` et lancez avec `--provider openai`
- **Ollama** — entièrement local, sans clé : démarrez Ollama et lancez avec `--provider ollama --use-llm`. `--use-llm` est obligatoire — `--provider` ne fait que choisir le fournisseur ; la synthèse LLM doit être activée explicitement.

Chaque chapitre produit par un LLM obéit à une règle absolue : **chaîne de preuves ou rien.** Les affirmations que le modèle ne peut pas étayer par une référence à un commit, une PR, une review ou une issue doivent être marquées *(inférence)* — les assertions invérifiables n'ont pas leur place dans un document de passation.

## Comment le risque est noté (et pourquoi vous pouvez vous y fier)

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

Chaque point du Top 5 des risques liste les commits, reviews et issues exacts qui justifient sa note — chacun étant un lien profond vers le dépôt. La formule vit dans [`src/risk/engine.ts`](src/risk/engine.ts) — lisez-la, contestez-la, ajustez-la.

## Architecture

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown +   │
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  print-ready  │
│  Local git   │   │  Q&A capture  │  │  incidents   │   │  HTML book    │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## Plugins d'éditeur

Le même CLI pilote trois intégrations. La couche commune est un **serveur MCP intégré** (`handover-mcp`, livré dans le paquet npm) qui expose `handover_generate`, `handover_collect`, `handover_risk`, `handover_capture`, `handover_search` (consultation de preuves en lecture seule pour les questions de suivi), `handover_render` et `handover_verify` (vérifie chaque citation de preuve contre l'index) comme outils — n'importe quel client MCP peut l'utiliser sans passer par le CLI.

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — installez le plugin fourni :

```
/plugin marketplace add a742987/Handover
/plugin install handover@handover
```

Le plugin enregistre automatiquement le serveur MCP `handover` (via le champ `mcpServers` dans [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json)) et ajoute :

- `/handover:gen <username> --repo owner/name` — le pipeline complet, puis un résumé du Top 5 des risques
- `/handover:risk <username>` — le Top 5 des risques à partir d'un index existant
- une skill qui apprend à l'agent quand et comment exécuter le pipeline ([`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md))

**Codex** — deux lignes :

1. Enregistrez le serveur MCP dans `~/.codex/config.toml` :
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. Copiez [`codex/handover.md`](codex/handover.md) vers `~/.codex/prompts/handover.md`, puis lancez `/handover <username> --repo owner/name`.

**Tout autre client MCP** (Cursor, ZCode, …) — enregistrez `handover-mcp` comme serveur stdio ; les mêmes sept outils partout.

## Vie privée et éthique — lisez ceci avant de le lancer pour quelqu'un

- **Un cadeau, pas un audit.** Handover existe pour remettre la carte à la personne qui succède, jamais pour noter celle qui part. Lancez-le *avec* l'ingénieur sur le départ, pas derrière son dos. Ses commentaires de review et messages de commit seront cités devant ses collègues — s'il ne l'écrirait pas dans un document d'adieu, ça n'a pas sa place dans le livre.
- **Local d'abord.** Collecte, indexation et rendu s'exécutent tous sur votre machine. Les seuls appels réseau vont à l'API de GitHub et à votre fournisseur de LLM configuré. Choisissez **Ollama** et pas un seul octet du contenu du dépôt ne parvient à un tiers.
- **L'index est sensible.** `handover-data/*.db` contient tout l'historique de commits de votre équipe. Il est gitignoré par défaut ; traitez le fichier comme un identifiant secret.
- **L'hallucination est un bug, pas une bizarrerie.** La sortie du LLM doit citer des références de preuves ; les affirmations non étayées doivent être marquées *(inférence)*. Ne faites confiance à aucun chapitre que vous n'avez pas vérifié contre sa chaîne de preuves.
- **L'anonymisation** (noms réels → codes de rôle, pour les contextes RH) figure sur la feuille de route avant toute version équipe/entreprise.

## Développement

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

Stack : TypeScript · Node (`node:sqlite` intégré) · Octokit · fournisseurs de LLM remplaçables. La CI exécute typecheck + tests + build à chaque push.

## Feuille de route

- [x] Squelette du dépôt : CLI + collecte Octokit + index SQLite + moteur de risque + livre Markdown
- [x] Serveur MCP (`handover-mcp`) + plugin Claude Code + prompt Codex
- [x] Collecte depuis des clones git locaux (`--git-dir`) — sans token, sans réseau
- [x] `handover capture` — questions/réponses à la première personne reliées dans le chapitre 6 (CLI + MCP)
- [x] `handover bus-factor` — vue d'équipe avec fusion de CODEOWNERS
- [x] Jumeau HTML monofichier prêt à imprimer (`--html` ; impression depuis le navigateur → PDF)
- [x] Intégration CI — `risk --json`, commande `gate` + workflow d'exemple
- [x] Outil MCP `handover_search` + nettoyage des secrets avec `--redact`
- [x] Première page de résumé d'actions avec couverture des données, vérification des citations par `handover verify` et interrupteur explicite `--no-llm`
- [x] Livre d'exemple versionné dans le dépôt avec relevé de vérification (`examples/sample-report/`)
- [x] Bout en bout depuis le paquet npm publié dans un environnement propre : installer → `gen` (Git local, `--no-llm`) → `verify` ([relevé de vérification](docs/install-verification.md))
- [ ] Collecte avec token GitHub (`-r owner/name`) de bout en bout sur un dépôt public, et un environnement Unix dans l'exécution propre
- [ ] Lecteur web local avec liens profonds vers les preuves (v0.2)
- [ ] Carte des risques de compétences à l'échelle de l'organisation (v1.0)

## Nom

Le paquet npm est `handover-book` (`handover` est occupé par un paquet déprécié) ; la commande CLI est `handover`. Le nom final du produit reste à décider — voir §8.1 du plan de projet.

## Licence

[MIT](LICENSE)
