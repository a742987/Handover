[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | **Deutsch** | [Монгол](README.mn.md) | [العربية](README.ar.md)

# Handover

> **Wenn ein Entwickler geht, sollte sein Wissen nicht mitgehen.**
> Richte Handover auf den Benutzernamen eines auscheidenden Engineers, und es liest alles, was er je committet, reviewt und vertreten hat — und erzeugt daraus ein gebundenes, mit Belegen verknüpftes **Handover Book** (das Übergabebuch) für die Person, die seine Stelle übernimmt.

Ein Befehl. Vollständig lokal. Nichts über deine Codebasis verlässt jemals deinen Rechner.

```bash
handover gen <username> --repo owner/name
```

---

## Warum

`git blame` sagt dir, *wer* eine Zeile geschrieben hat. Es sagt dir nicht *warum* — oder welche Module stillschweigend ihren einzigen Reviewer verlieren, oder welche „komische“ Design-Entscheidung in Wahrheit tragend ist. Wikis hängen davon ab, dass Menschen freiwillig schreiben, und Exit-Meetings beginnen, nachdem die Kündigung verkündet wurde, und enden, bevor das Wissen übertragen ist.

Handover deckt die impliziten Verluste ab, die sonst nichts abdeckt:

1. **Code-Panorama** — jedes Modul, das sie angefasst haben, sein Zustand und seine Geschichte
2. **Inventar impliziten Wissens** — Module, in denen sie der *einzige* Autor oder der *einzige* Reviewer waren
3. **Top-5-Risiken** — „was kaputtgeht, wenn sie gehen“, ranggelegt und bewertet, jeder Punkt mit einer Belegkette
4. **Entscheidungsarchäologie** — „warum wir uns damals dafür entschieden haben“, mit den wörtlichen PR-/Issue-Diskussionen zitiert
5. **Der 30-Tage-Pfad** — der Lernplan für die Nachfolge
6. **Brief in die Zukunft** — die Fragen, die die Nachfolge stellen wird, beantwortet in der eigenen Stimme der gehenden Entwicklerin oder des gehenden Entwicklers

## Schnellstart

Voraussetzungen: **Node ≥ 22.5** (bringt SQLite eingebaut mit — keine native Kompilierung), ein GitHub-Token für vernünftige Rate-Limits.

```bash
git clone <this repo> && cd handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

Die Ausgabe landet in `handover-data/`:

- `handover-data/<username>.db` — der lokale SQLite-Index (eine Datei pro Person; weitere Läufe sind inkrementell und nahezu sofort)
- `handover-data/handover-book-<username>.md` — das gebundene Buch

### Befehle

| Befehl | Was er tut |
|---|---|
| `gen <username> -r owner/name` | sammeln → analysieren → das gesamte Buch rendern |
| `collect <username> -r owner/name` | nur den GitHub-Verlauf indizieren (Commits, PRs, Reviews und Issues, die bereits im Index sind, werden übersprungen) |
| `risk <username>` | die Top-5-Risiken aus dem lokalen Index ausgeben |
| `render <username>` | das Buch aus dem Index neu rendern (kein Netzwerk; Repositories werden aus dem Index gelesen, mit `-r` überschreibbar) |

Häufige Flags: `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>`, `--data-dir <dir>`, `--refresh` (bereits Indiziertes erneut abrufen).

### LLM-Anbieter

Die Kapitel 1–3 werden deterministisch aus dem Index berechnet — sie funktionieren immer, mit oder ohne API-Schlüssel. Die Kapitel 4–6 werden von einem LLM synthetisiert; **ohne Schlüssel fallen sie auf deterministische Zusammenfassungen zurück**, statt zu scheitern.

- **Anthropic** — `ANTHROPIC_API_KEY` setzen (Standardanbieter)
- **OpenAI** — `OPENAI_API_KEY` setzen und mit `--provider openai` ausführen
- **Ollama** — vollständig lokal, ohne Schlüssel: Ollama starten und mit `--provider ollama` ausführen

Jedes LLM-Kapitel folgt einer harten Regel: **Belegkette oder nichts.** Aussagen, die das Modell nicht mit einem Commit-, PR-, Review- oder Issue-Verweis belegen kann, müssen als *(inference)* gekennzeichnet werden — unbelegbare Behauptungen haben in einem Übergabedokument nichts verloren.

## Wie das Risiko bewertet wird (und warum du ihm vertrauen kannst)

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

Jeder Punkt der Top-5-Risiken listet die exakten Commits, Reviews und Issues auf, die seine Bewertung begründen — jeder davon ein Deep Link in das Repository. Die Formel liegt in [`src/risk/engine.ts`](src/risk/engine.ts) — lies sie, hinterfrage sie, justiere sie.

## Architektur

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## Editor-Plugins

Dieselbe CLI treibt drei Integrationen an. Die gemeinsame Schicht ist ein **eingebauter MCP-Server** (`handover-mcp`, im npm-Paket enthalten), der `handover_generate`, `handover_collect`, `handover_risk` und `handover_render` als Tools bereitstellt — jeder MCP-Client kann ihn nutzen, ohne die CLI aufrufen zu müssen.

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — das gebündelte Plugin installieren:

```
/plugin marketplace add <this-repo>
/plugin install handover@handover
```

Das Plugin registriert den `handover`-MCP-Server automatisch (über das Feld `mcpServers` in [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json)) und ergänzt:

- `/handover:gen <username> --repo owner/name` — die komplette Pipeline, danach eine zusammengefasste Übersicht der Top-5-Risiken
- `/handover:risk <username>` — Top-5-Risiken aus einem bestehenden Index
- ein Skill, der dem Agenten beibringt, wann und wie die Pipeline auszuführen ist ([`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md))

**Codex** — zwei Zeilen:

1. Den MCP-Server in `~/.codex/config.toml` registrieren:
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. [`codex/handover.md`](codex/handover.md) nach `~/.codex/prompts/handover.md` kopieren, dann `/handover <username> --repo owner/name` ausführen.

**Jeder andere MCP-Client** (Cursor, ZCode, …) — `handover-mcp` als stdio-Server registrieren; überall dieselben vier Tools.

## Datenschutz und Ethik — lies das, bevor du es für jemanden ausführst

- **Ein Geschenk, kein Audit.** Handover existiert, um einer Nachfolge die Karte zu übergeben — niemals, um die gehende Person zu benoten. Führe es *mit* dem auscheidenden Engineer aus, nicht an ihm vorbei. Ihre Review-Kommentare und Commit-Messages werden Kolleginnen und Kollegen zitiert — was sie nicht in ein Abschiedsdokument schreiben würden, gehört nicht ins Buch.
- **Local-first.** Sammeln, Indizieren, Synthese und Rendering laufen allesamt auf deinem Rechner. Die einzigen Netzwerkaufrufe gehen an die GitHub-API und deinen konfigurierten LLM-Anbieter. Wähle **Ollama**, und kein einziges Byte Repository-Inhalt erreicht Dritte.
- **Der Index ist sensibel.** `handover-data/*.db` enthält die vollständige Commit-Historie deines Teams. Sie ist standardmäßig gitignored; behandle die Datei wie ein Credential.
- **Halluzination ist ein Bug, keine Eigenart.** LLM-Ausgaben müssen Belegverweise zitieren; unbelegte Aussagen müssen als *(inference)* gekennzeichnet sein. Vertraue keinem Kapitel, das du nicht gegen seine Belegkette gestichelt hast.
- **Anonymisierung** (echte Namen → Rollencodes, für HR-Kontexte) ist auf der Roadmap, bevor irgendeine Team-/Enterprise-Stufe ausgeliefert wird.

## Entwicklung

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

Stack: TypeScript · Node (eingebaut `node:sqlite`) · Octokit · austauschbare LLM-Anbieter. CI führt bei jedem Push typecheck + Tests + Build aus.

## Roadmap

- [x] Repo-Grundgerüst: CLI + Octokit-Sammlung + SQLite-Index + Risk-Engine + Markdown-Buch
- [x] MCP-Server (`handover-mcp`) + Claude-Code-Plugin + Codex-Prompt
- [ ] `npx handover-book gen` Ende-zu-Ende in einem echten öffentlichen Repository (MVP, Wochen 1–3)
- [ ] PDF-/HTML-Ausgabe und die Umblätter-Demo
- [ ] 30-Tage-Pfad + Brief in die Zukunft mit LLM-Style-Transfer-Politur (v0.2)
- [ ] Lokaler Web-Reader mit Beleg-Deep-Links (v0.2)
- [ ] Organisationsweiter Fähigkeits-Risikokarte (v1.0)

## Namensgebung

Das npm-Paket heißt `handover-book` (`handover` ist durch ein eingestelltes Paket belegt); der CLI-Befehl ist `handover`. Der finale Produktname ist noch offen — siehe §8.1 des Projektplans.

## Lizenz

[MIT](LICENSE)
