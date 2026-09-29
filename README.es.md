[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | **Español** | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

> Las traducciones de la comunidad pueden ir por detrás del README en inglés en los pasos de instalación y el flujo de datos.

# Handover

> **Cuando una persona desarrolladora se va, su conocimiento no debería irse con ella.**
> Apunta Handover al nombre de usuario de un ingeniero que se marcha, y leerá todo lo que jamás haya confirmado, revisado o defendido — para luego producir un **Libro de Relevo** (Handover Book) encuadernado y con enlaces a la evidencia, para quien ocupe su puesto.

Un solo comando. Se ejecuta localmente. Cuando se configura un proveedor LLM (lo predeterminado), el contenido del repositorio recopilado se envía a él para su síntesis; sin una clave API, todo permanece determinista y local.

```bash
handover gen <username> --repo owner/name
```

---

## Por qué

`git blame` te dice *quién* escribió una línea. No puede decirte *por qué* — ni qué módulos perderán en silencio a su único revisor, ni qué decisión de diseño "extraña" es en realidad estructural. Las wikis dependen de que la gente escriba voluntariamente, y las reuniones de salida empiezan cuando ya se anunció la renuncia y terminan antes de que el conocimiento se haya transferido.

Handover cubre las pérdidas implícitas que nada más cubre:

1. **Panorama del código** — cada módulo que tocó, su estado y su historia
2. **Inventario de conocimiento implícito** — módulos donde fue el *único* autor o el *único* revisor
3. **Top 5 de riesgos** — "qué se rompe cuando se vaya", clasificado y puntuado, cada elemento con su cadena de evidencia
4. **Arqueología de decisiones** — "por qué elegimos esto en su momento", citando los debates reales de PR e issues
5. **La ruta de 30 días** — el plan de aprendizaje de la persona sucesora
6. **Preguntas y respuestas en borrador** — qué preguntar antes del último día, además de las respuestas grabadas por la propia persona que se marcha

## Inicio rápido

El camino más corto — un solo comando, sin clonar el repositorio (requiere Node ≥ 22.13, con SQLite integrado — sin compilación nativa):

```bash
npm install -g handover-book

# desde GitHub (necesita un token para unos límites de peticiones razonables):
export GITHUB_TOKEN=ghp_...
handover gen <username> --repo owner/name --html

# o sin token y sin red — lee directamente los clones locales de la persona:
handover gen <username> --git-dir ~/work/api --git-dir ~/work/web
```

El resultado queda en `handover-data/`:

- `handover-data/<username>.db` — el índice SQLite local (un archivo por persona; las ejecuciones siguientes son incrementales y casi instantáneas)
- `handover-data/handover-book-<username>.md` — el libro encuadernado (con `--html`, un gemelo HTML de un solo archivo listo para imprimir; imprimirlo desde el navegador te da el PDF)

¿Prefieres ejecutarlo desde el código fuente? `git clone https://github.com/a742987/Handover && cd Handover && npm install && npm run dev -- gen <username> --repo owner/name`.

### Comandos

| Comando | Qué hace |
|---|---|
| `gen <username> -r owner/name` | recopilar → analizar → renderizar el libro completo |
| `collect <username> -r owner/name [-d dir]` | solo indexa el historial (los commits, PRs, reviews e issues ya presentes en el índice se omiten) |
| `capture <username>` | sentarse con la persona que se marcha y grabar sus propias respuestas; quedan encuadernadas en el capítulo 6 (`--answers q.json` para agentes y scripts) |
| `risk <username> [--json]` | imprime el Top 5 de riesgos a partir del índice local |
| `bus-factor <username>` | vista de equipo: qué módulos reciben commits de una sola persona, con fusión de CODEOWNERS cuando el repositorio tiene uno |
| `gate <username> --files changed.txt` | comprobación de CI: ¿este conjunto de cambios toca módulos de propietario único? (`--comment`, `--fail-on-match`, `--repo owner/name` para acotar un índice multi-repositorio; ver [`examples/sole-owner-gate-action.yml`](examples/sole-owner-gate-action.yml)) |
| `verify <username>` | comprobación de existencia de citas: cada referencia citada en el libro renderizado debe existir en el índice (exit 1 si falta alguna — apto para CI, `--json` para máquinas) |
| `render <username>` | vuelve a renderizar el libro desde el índice, sin acceso a GitHub (los capítulos 4-6 solo llaman al proveedor LLM si hay una clave API configurada; pasa `-r` para sobrescribir los repositorios registrados en el índice) |

Flags comunes: `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>`, `--data-dir <dir>`, `--refresh` (vuelve a obtener lo que ya está indexado), `--html` (gemelo HTML listo para imprimir), `--redact` (elimina los formatos de secretos conocidos del resumen para el LLM y del libro; también `HANDOVER_REDACT=1`), `--no-llm` (omite la síntesis del LLM aunque haya una clave configurada — solo capítulos deterministas, nada sale de la máquina; también `HANDOVER_NO_LLM=1`). `gen` y `collect` aceptan `--author <identity>` para hacer coincidir el nombre/correo de la persona que se marcha en los clones locales.

### Proveedores de LLM

Los capítulos 1–3 se calculan de forma determinista a partir del índice — siempre funcionan, con o sin clave de API. Los capítulos 4–6 los sintetiza un LLM; **sin clave recurren a resúmenes deterministas** en lugar de fallar.

- **Anthropic** — define `ANTHROPIC_API_KEY` (proveedor por defecto)
- **OpenAI** — define `OPENAI_API_KEY` y ejecuta con `--provider openai`
- **Ollama** — completamente local, sin clave: arranca Ollama y ejecuta con `--provider ollama`

Cada capítulo de LLM opera bajo una regla estricta: **cadena de evidencia o nada.** Las afirmaciones que el modelo no pueda respaldar con una referencia a un commit, PR, review o issue deben marcarse como *(inferencia)* — las afirmaciones no verificables no tienen sitio en un documento de relevo.

## Cómo se puntúa el riesgo (y por qué puedes confiar en él)

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

Cada elemento del Top 5 de riesgos lista los commits, reviews e issues exactos que justifican su puntuación — cada uno con un enlace profundo al repositorio. La fórmula vive en [`src/risk/engine.ts`](src/risk/engine.ts) — léela, cuestionala, ajústala.

## Arquitectura

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown +   │
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  print-ready  │
│  Local git   │   │  Q&A capture  │  │  incidents   │   │  HTML book    │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## Plugins para editores

El mismo CLI impulsa tres integraciones. La capa común es un **servidor MCP integrado** (`handover-mcp`, incluido en el paquete npm) que expone `handover_generate`, `handover_collect`, `handover_risk`, `handover_capture`, `handover_search` (consulta de evidencia de solo lectura para preguntas de seguimiento) y `handover_render` como herramientas — cualquier cliente MCP puede usarlo sin invocar el CLI por debajo.

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — instala el plugin incluido:

```
/plugin marketplace add a742987/Handover
/plugin install handover@handover
```

El plugin registra automáticamente el servidor MCP `handover` (mediante el campo `mcpServers` en [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json)) y añade:

- `/handover:gen <username> --repo owner/name` — el pipeline completo y, después, un resumen del Top 5 de riesgos
- `/handover:risk <username>` — el Top 5 de riesgos a partir de un índice existente
- una skill que enseña al agente cuándo y cómo ejecutar el pipeline ([`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md))

**Codex** — dos líneas:

1. Registra el servidor MCP en `~/.codex/config.toml`:
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. Copia [`codex/handover.md`](codex/handover.md) en `~/.codex/prompts/handover.md` y ejecuta `/handover <username> --repo owner/name`.

**Cualquier otro cliente MCP** (Cursor, ZCode, …) — registra `handover-mcp` como servidor stdio; las mismas seis herramientas en todas partes.

## Privacidad y ética — lee esto antes de ejecutarlo para alguien

- **Un regalo, no una auditoría.** Handover existe para entregar el mapa a quien sucede, nunca para calificar a quien se marcha. Ejecútalo *con* el ingeniero saliente, no a sus espaldas. Sus comentarios de review y mensajes de commit se citarán ante sus colegas — si no lo diría en un documento de despedida, no pertenece al libro.
- **Local primero.** La recopilación, indexación y renderizado se ejecutan en tu máquina. Las únicas llamadas de red son a la API de GitHub y a tu proveedor de LLM configurado. Elige **Ollama** y ni un solo byte del contenido del repositorio llega a terceros.
- **El índice es sensible.** `handover-data/*.db` contiene todo el historial de commits de tu equipo. Está en el gitignore por defecto; trata el archivo como una credencial.
- **La alucinación es un bug, no una peculiaridad.** La salida del LLM debe citar referencias de evidencia; las afirmaciones sin respaldo deben marcarse como *(inferencia)*. No te fíes de ningún capítulo que no hayas cotejado con su cadena de evidencia.
- **Anonimización** (nombres reales → códigos de rol, para contextos de RR. HH.) está en la hoja de ruta antes de lanzar cualquier nivel de equipo/empresa.

## Desarrollo

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

Stack: TypeScript · Node (`node:sqlite` integrado) · Octokit · proveedores de LLM intercambiables. La CI ejecuta typecheck + tests + build en cada push.

## Hoja de ruta

- [x] Estructura del repositorio: CLI + recopilación con Octokit + índice SQLite + motor de riesgo + libro en Markdown
- [x] Servidor MCP (`handover-mcp`) + plugin de Claude Code + prompt de Codex
- [x] Recopilación desde clones git locales (`--git-dir`) — sin token, sin red
- [x] `handover capture` — preguntas y respuestas en primera persona encuadernadas en el capítulo 6 (CLI + MCP)
- [x] `handover bus-factor` — vista de equipo con fusión de CODEOWNERS
- [x] Gemelo HTML de un solo archivo listo para imprimir (`--html`; imprimir desde el navegador → PDF)
- [x] Integración con CI — `risk --json`, comando `gate` + workflow de ejemplo
- [x] Herramienta MCP `handover_search` + limpieza de secretos con `--redact`
- [x] Primera página de resumen de acciones con la cobertura de datos, comprobación de citas con `handover verify` e interruptor explícito `--no-llm`
- [x] Libro de ejemplo versionado en el repositorio con registro de verificación (`examples/sample-report/`)
- [x] Extremo a extremo en un entorno limpio desde el paquete npm publicado: instalar → `gen` (Git local, `--no-llm`) → `verify` ([registro de verificación](docs/install-verification.md))
- [ ] Recopilación con token de GitHub (`-r owner/name`) de extremo a extremo en un repositorio público, y un entorno Unix en la ejecución limpia
- [ ] Lector web local con enlaces profundos a la evidencia (v0.2)
- [ ] Mapa de riesgo de capacidades para toda la organización (v1.0)

## Nombre

El paquete npm es `handover-book` (`handover` está ocupado por un paquete obsoleto); el comando CLI es `handover`. El nombre final del producto sigue abierto — ver §8.1 del plan del proyecto.

## Licencia

[MIT](LICENSE)
