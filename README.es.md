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
6. **Carta al futuro** — las preguntas que hará la persona sucesora, respondidas con la propia voz de quien se marcha

## Inicio rápido

Requisitos: **Node ≥ 22.13** (incluye SQLite integrado — sin compilación nativa), un token de GitHub para unos límites de peticiones razonables.

```bash
git clone https://github.com/a742987/Handover.git && cd Handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

El resultado queda en `handover-data/`:

- `handover-data/<username>.db` — el índice SQLite local (un archivo por persona; las ejecuciones siguientes son incrementales y casi instantáneas)
- `handover-data/handover-book-<username>.md` — el libro encuadernado

### Comandos

| Comando | Qué hace |
|---|---|
| `gen <username> -r owner/name` | recopilar → analizar → renderizar el libro completo |
| `collect <username> -r owner/name` | solo indexa el historial de GitHub (los commits, PRs, reviews e issues ya presentes en el índice se omiten) |
| `risk <username>` | imprime el Top 5 de riesgos a partir del índice local |
| `render <username>` | vuelve a renderizar el libro desde el índice, sin acceso a GitHub (los capítulos 4-6 solo llaman al proveedor LLM si hay una clave API configurada; pasa `-r` para sobrescribir los repositorios registrados en el índice) |

Flags comunes: `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>`, `--data-dir <dir>`, `--refresh` (vuelve a obtener lo que ya está indexado).

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
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## Plugins para editores

El mismo CLI impulsa tres integraciones. La capa común es un **servidor MCP integrado** (`handover-mcp`, incluido en el paquete npm) que expone `handover_generate`, `handover_collect`, `handover_risk` y `handover_render` como herramientas — cualquier cliente MCP puede usarlo sin invocar el CLI por debajo.

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

**Cualquier otro cliente MCP** (Cursor, ZCode, …) — registra `handover-mcp` como servidor stdio; las mismas cuatro herramientas en todas partes.

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
- [ ] `npx handover-book gen` de principio a fin en un repositorio público real (MVP, semanas 1–3)
- [ ] Salida PDF / HTML y la demo de paso de páginas
- [ ] Ruta de 30 días + Carta al futuro con pulido de transferencia de estilo del LLM (v0.2)
- [ ] Lector web local con enlaces profundos a la evidencia (v0.2)
- [ ] Mapa de riesgo de capacidades para toda la organización (v1.0)

## Nombre

El paquete npm es `handover-book` (`handover` está ocupado por un paquete obsoleto); el comando CLI es `handover`. El nombre final del producto sigue abierto — ver §8.1 del plan del proyecto.

## Licencia

[MIT](LICENSE)
