[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | **Français** | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

# Handover

> **Quand un·e développeur·se part, son savoir ne devrait pas partir avec lui.**
> Pointez Handover vers le nom d'utilisateur d'un ingénieur sur le départ, et il lira tout ce qu'il ou elle a jamais commité, relu et défendu — puis produira un **Livre de Passation** (Handover Book) relié et adossé aux preuves, pour la personne qui prend la relève.

Une seule commande. Entièrement local. Rien de votre base de code ne quitte jamais votre machine.

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
6. **Lettre au futur** — les questions que posera la personne qui succède, répondues avec la voix même de la personne qui part

## Démarrage rapide

Prérequis : **Node ≥ 22.5** (livré avec SQLite intégré — pas de compilation native), un token GitHub pour des limites de requêtes raisonnables.

```bash
git clone <this repo> && cd handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

Le résultat atterrit dans `handover-data/` :

- `handover-data/<username>.db` — l'index SQLite local (un fichier par personne ; les exécutions suivantes sont incrémentales et quasi instantanées)
- `handover-data/handover-book-<username>.md` — le livre relié

### Commandes

| Commande | Ce qu'elle fait |
|---|---|
| `gen <username> -r owner/name` | collecter → analyser → générer le livre complet |
| `collect <username> -r owner/name` | indexer uniquement l'historique GitHub (les commits, PRs, reviews et issues déjà présents dans l'index sont ignorés) |
| `risk <username>` | afficher le Top 5 des risques à partir de l'index local |
| `render <username>` | régénérer le livre à partir de l'index (sans réseau ; les dépôts sont lus depuis l'index, passez `-r` pour les remplacer) |

Flags courants : `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>`, `--data-dir <dir>`, `--refresh` (récupère à nouveau ce qui est déjà indexé).

### Fournisseurs de LLM

Les chapitres 1 à 3 sont calculés de façon déterministe à partir de l'index — ils fonctionnent toujours, avec ou sans clé d'API. Les chapitres 4 à 6 sont synthétisés par un LLM ; **sans clé, ils retombent sur des résumés déterministes** au lieu d'échouer.

- **Anthropic** — définissez `ANTHROPIC_API_KEY` (fournisseur par défaut)
- **OpenAI** — définissez `OPENAI_API_KEY` et lancez avec `--provider openai`
- **Ollama** — entièrement local, sans clé : démarrez Ollama et lancez avec `--provider ollama`

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
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## Plugins d'éditeur

Le même CLI pilote trois intégrations. La couche commune est un **serveur MCP intégré** (`handover-mcp`, livré dans le paquet npm) qui expose `handover_generate`, `handover_collect`, `handover_risk` et `handover_render` comme outils — n'importe quel client MCP peut l'utiliser sans passer par le CLI.

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — installez le plugin fourni :

```
/plugin marketplace add <this-repo>
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

**Tout autre client MCP** (Cursor, ZCode, …) — enregistrez `handover-mcp` comme serveur stdio ; les mêmes quatre outils partout.

## Vie privée et éthique — lisez ceci avant de le lancer pour quelqu'un

- **Un cadeau, pas un audit.** Handover existe pour remettre la carte à la personne qui succède, jamais pour noter celle qui part. Lancez-le *avec* l'ingénieur sur le départ, pas derrière son dos. Ses commentaires de review et messages de commit seront cités devant ses collègues — s'il ne l'écrirait pas dans un document d'adieu, ça n'a pas sa place dans le livre.
- **Local d'abord.** Collecte, indexation, synthèse et rendu s'exécutent tous sur votre machine. Les seuls appels réseau vont à l'API de GitHub et à votre fournisseur de LLM configuré. Choisissez **Ollama** et pas un seul octet du contenu du dépôt ne parvient à un tiers.
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
- [ ] `npx handover-book gen` de bout en bout sur un vrai dépôt public (MVP, semaines 1–3)
- [ ] Sortie PDF / HTML et la démo de tournage de pages
- [ ] Parcours des 30 jours + Lettre au futur avec une finition par transfert de style du LLM (v0.2)
- [ ] Lecteur web local avec liens profonds vers les preuves (v0.2)
- [ ] Carte des risques de compétences à l'échelle de l'organisation (v1.0)

## Nom

Le paquet npm est `handover-book` (`handover` est occupé par un paquet déprécié) ; la commande CLI est `handover`. Le nom final du produit reste à décider — voir §8.1 du plan de projet.

## Licence

[MIT](LICENSE)
