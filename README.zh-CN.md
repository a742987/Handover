[English](README.md) | **简体中文** | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

# Handover（交接手册）

> **开发者离开时，他们的知识不应该随之离开。**
> 把离职工程师的用户名交给 Handover，它会读取他们提交过、评审过、为之争论过的一切 —— 然后为接任者生成一本装订成册、证据可溯的 **Handover Book（交接手册）**。

一条命令。完全本地运行。你的代码库的任何信息都不会离开你的机器。

```bash
handover gen <username> --repo owner/name
```

---

## 为什么需要它

`git blame` 能告诉你某一行是*谁*写的，却无法告诉你*为什么* —— 也无法告诉你哪些模块会悄悄失去唯一的评审者，或者哪些"奇怪"的设计决策其实承重核心。Wiki 依赖人们自发地书写，而离职面谈总是在辞职宣布之后才开始、在知识传递完成之前就结束。

Handover 覆盖其他工具无法覆盖的隐性损失：

1. **代码全景** —— 他们 touch 过的每一个模块、其状态与历史
2. **隐性知识清单** —— 他们是*唯一*作者或*唯一*评审者的模块
3. **风险 Top 5** —— "他们离开后什么会出问题"，逐项排序打分，每项附带证据链
4. **决策考古** —— "当年我们为什么这样选"，引用真实的 PR/issue 讨论原文
5. **30 天上手路径** —— 接任者的学习计划
6. **写给未来的信** —— 接任者会问的问题，由离职开发者本人的语气作答

## 快速开始

环境要求：**Node ≥ 22.5**（内置 SQLite —— 无需原生编译），以及一个用于合理速率限制的 GitHub token。

```bash
git clone <this repo> && cd handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

输出位于 `handover-data/`：

- `handover-data/<username>.db` —— 本地 SQLite 索引（每人一个文件；第二次运行增量更新，几乎瞬间完成）
- `handover-data/handover-book-<username>.md` —— 装订成册的手册

### 命令

| 命令 | 作用 |
|---|---|
| `gen <username> -r owner/name` | 采集 → 分析 → 渲染出完整手册 |
| `collect <username> -r owner/name` | 仅索引 GitHub 历史（索引中已有的 commit、PR、review 和 issue 会被跳过） |
| `risk <username>` | 从本地索引打印风险 Top 5 |
| `render <username>` | 从索引重新渲染手册（不访问网络；仓库信息从索引读取，可用 `-r` 覆盖） |

常用参数：`--provider openai|anthropic|ollama`、`--model <model>`、`--since <ISO date>`、`--data-dir <dir>`、`--refresh`（重新抓取已索引的内容）。

### LLM 提供方

第 1–3 章直接从索引确定性计算 —— 无论有没有 API key 都能正常工作。第 4–6 章由 LLM 生成；**没有 key 时会退回到确定性摘要**，而不会报错失败。

- **Anthropic** —— 设置 `ANTHROPIC_API_KEY`（默认提供方）
- **OpenAI** —— 设置 `OPENAI_API_KEY`，并以 `--provider openai` 运行
- **Ollama** —— 完全本地、无需 key：启动 Ollama 后以 `--provider ollama` 运行

每个 LLM 章节都遵守一条硬性规则：**要么有证据链，要么不作数。**模型无法用 commit、PR、review 或 issue 引用来支撑的论断，必须标注 *(inference)*（推断）—— 无法验证的说法没有资格出现在交接文档里。

## 风险如何打分（以及为什么你可以信任它）

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

风险 Top 5 的每一项都会列出支撑其分数的确切 commit、review 和 issue —— 每一条都是指向仓库的深层链接。公式位于 [`src/risk/engine.ts`](src/risk/engine.ts) —— 读一读，质疑它，调整它。

## 架构

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## 编辑器插件

同一个 CLI 驱动三套集成。公共层是一个**内置 MCP 服务器**（`handover-mcp`，随 npm 包一起发布），它把 `handover_generate`、`handover_collect`、`handover_risk` 和 `handover_render` 暴露为工具 —— 任何 MCP 客户端都可以直接使用，无需调用 CLI。

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** —— 安装随附的插件：

```
/plugin marketplace add <this-repo>
/plugin install handover@handover
```

该插件会自动注册 `handover` MCP 服务器（通过 [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json) 中的 `mcpServers` 字段），并添加：

- `/handover:gen <username> --repo owner/name` —— 完整流水线，随后输出一份摘要版风险 Top 5
- `/handover:risk <username>` —— 从已有索引输出风险 Top 5
- 一个教会 agent 何时以及如何运行流水线的 skill（[`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md)）

**Codex** —— 只需两步：

1. 在 `~/.codex/config.toml` 中注册 MCP 服务器：
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. 把 [`codex/handover.md`](codex/handover.md) 复制到 `~/.codex/prompts/handover.md`，然后运行 `/handover <username> --repo owner/name`。

**其他任何 MCP 客户端**（Cursor、ZCode 等）—— 把 `handover-mcp` 注册为 stdio 服务器即可；到处都是同样的四个工具。

## 隐私与伦理 —— 在为别人运行之前请先读这一节

- **这是一份礼物，不是一次审计。** Handover 的存在是为了把地图交到接任者手中，绝不是给离职者打分。请*与*离职工程师一起运行它，而不是绕开他们。他们的 review 评论和 commit 信息会被原话引用给同事 —— 如果他们不会在告别文档里这样说，那它就不该出现在手册里。
- **本地优先。** 采集、索引、生成和渲染全部在你的机器上运行。仅有的网络调用是发往 GitHub API 和你配置的 LLM 提供方。选择 **Ollama**，仓库内容将连一个字节都不会到达任何第三方。
- **索引文件是敏感的。** `handover-data/*.db` 包含你们团队的完整 commit 历史。它默认已被 gitignore；请像对待凭据一样对待这个文件。
- **幻觉是 bug，不是小毛病。** LLM 输出必须引用证据引用（evidence refs）；无依据的说法必须标注 *(inference)*。别相信任何你还没有对照证据链抽查过的章节。
- **匿名化**（真实姓名 → 角色代号，用于 HR 场景）已列入路线图，将在任何团队/企业版发布之前完成。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

技术栈：TypeScript · Node（内置 `node:sqlite`）· Octokit · 可插拔的 LLM 提供方。CI 在每次 push 时运行 typecheck + 测试 + 构建。

## 路线图

- [x] 仓库脚手架：CLI + Octokit 采集 + SQLite 索引 + 风险引擎 + Markdown 手册
- [x] MCP 服务器（`handover-mcp`）+ Claude Code 插件 + Codex prompt
- [ ] 在一个真实的公开仓库上端到端跑通 `npx handover-book gen`（MVP，第 1–3 周）
- [ ] PDF / HTML 输出与翻页演示
- [ ] 30 天上手路径 + 写给未来的信，加入 LLM 风格迁移润色（v0.2）
- [ ] 带证据深层链接的本地 web 阅读器（v0.2）
- [ ] 组织级能力风险地图（v1.0）

## 命名

npm 包名为 `handover-book`（`handover` 已被一个废弃包占用）；CLI 命令为 `handover`。最终产品名称仍未确定 —— 见项目计划 §8.1。

## 许可证

[MIT](LICENSE)
