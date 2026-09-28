[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

# Handover（交接手冊）

> **當一位開發者離開時，他的知識不應該跟著離開。**
> 把離職工程師的帳號名稱交給 Handover，它會讀取他提交過、審核過、為之爭論過的一切 —— 然後為接任者產出一本裝訂成冊、證據可溯的 **Handover Book（交接手冊）**。

一行指令。在本機執行。設定 LLM 提供者時（預設行為），收集到的儲存庫內容會被傳送至該提供者進行合成；未設定 API 金鑰時，所有內容都保持確定性的本機處理。

```bash
handover gen <username> --repo owner/name
```

---

## 為什麼需要它

`git blame` 能告訴你某一行的*作者*是誰，卻無法告訴你*為什麼* —— 也無法告訴你哪些模組會悄悄失去唯一的審核者，或者哪些「奇怪」的設計決策其實是承重核心。Wiki 依賴人們自發性地撰寫，而離職面談總是在辭職宣布之後才開始、在知識傳遞完成之前就結束。

Handover 涵蓋其他工具無法涵蓋的隱性損失：

1. **程式碼全景** —— 他碰過的每一個模組、其狀態與歷史
2. **隱性知識清單** —— 他是*唯一*作者或*唯一*審核者的模組
3. **風險 Top 5** —— 「他離開後什麼會出問題」，逐項排序評分，每項附帶證據鏈
4. **決策考古** —— 「當年我們為什麼這樣選」，引用真實的 PR/issue 討論原文
5. **30 天上手路徑** —— 接任者的學習計畫
6. **寫給未來的信** —— 接任者會問的問題，由離職開發者本人的語氣作答

## 快速開始

環境需求：**Node ≥ 22.13**（內建 SQLite —— 無需原生編譯），以及一個用於合理速率限制的 GitHub token。

```bash
git clone https://github.com/a742987/Handover.git && cd Handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

輸出位於 `handover-data/`：

- `handover-data/<username>.db` —— 本機 SQLite 索引（每人一個檔案；第二次執行增量更新，幾乎瞬間完成）
- `handover-data/handover-book-<username>.md` —— 裝訂成冊的手冊

### 指令

| 指令 | 作用 |
|---|---|
| `gen <username> -r owner/name` | 蒐集 → 分析 → 產出完整手冊 |
| `collect <username> -r owner/name` | 僅索引 GitHub 歷史（索引中已有的 commit、PR、review 與 issue 會被略過） |
| `risk <username>` | 從本機索引列印風險 Top 5 |
| `render <username>` | 從索引重新產出手冊，不連上 GitHub（第 4-6 章僅在設定了 API 金鑰時才呼叫 LLM 提供方；可用 `-r` 覆寫索引中記錄的儲存庫） |

常用參數：`--provider openai|anthropic|ollama`、`--model <model>`、`--since <ISO date>`、`--data-dir <dir>`、`--refresh`（重新抓取已索引的內容）。

### LLM 提供方

第 1–3 章直接從索引以確定性方式計算 —— 無論有沒有 API key 都能正常運作。第 4–6 章由 LLM 生成；**沒有 key 時會退回確定性摘要**，而不會報錯失敗。

- **Anthropic** —— 設定 `ANTHROPIC_API_KEY`（預設提供方）
- **OpenAI** —— 設定 `OPENAI_API_KEY`，並以 `--provider openai` 執行
- **Ollama** —— 完全本機、無需 key：啟動 Ollama 後以 `--provider ollama` 執行

每個 LLM 章節都遵守一條硬性規則：**要有證據鏈，否則不作數。**模型無法以 commit、PR、review 或 issue 引用作為依據的論述，必須標註 *(inference)*（推論）—— 無法驗證的說法沒有資格出現在交接文件裡。

## 風險如何評分（以及為什麼你可以信任它）

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

風險 Top 5 的每一項都會列出支撐其分數的確切 commit、review 與 issue —— 每一條都是指向儲存庫的深層連結。公式位於 [`src/risk/engine.ts`](src/risk/engine.ts) —— 讀一讀，質疑它，調整它。

## 架構

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## 編輯器外掛

同一個 CLI 驅動三套整合。共通層是一個**內建 MCP 伺服器**（`handover-mcp`，隨 npm 套件一併發布），它把 `handover_generate`、`handover_collect`、`handover_risk` 與 `handover_render` 公開為工具 —— 任何 MCP 用戶端都可以直接使用，無需呼叫 CLI。

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** —— 安裝隨附的外掛：

```
/plugin marketplace add a742987/Handover
/plugin install handover@handover
```

該外掛會自動註冊 `handover` MCP 伺服器（透過 [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json) 中的 `mcpServers` 欄位），並新增：

- `/handover:gen <username> --repo owner/name` —— 完整流程，接著輸出一份摘要版風險 Top 5
- `/handover:risk <username>` —— 從既有索引輸出風險 Top 5
- 一個教導 agent 何時以及如何執行流程的 skill（[`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md)）

**Codex** —— 只需兩步：

1. 在 `~/.codex/config.toml` 中註冊 MCP 伺服器：
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. 把 [`codex/handover.md`](codex/handover.md) 複製到 `~/.codex/prompts/handover.md`，然後執行 `/handover <username> --repo owner/name`。

**其他任何 MCP 用戶端**（Cursor、ZCode 等）—— 把 `handover-mcp` 註冊為 stdio 伺服器即可；到處都是同樣的四個工具。

## 隱私與倫理 —— 在為別人執行之前請先讀這一節

- **這是一份禮物，不是一次稽核。** Handover 的存在是為了把地圖交到接任者手中，絕不是要給離職者打分數。請*與*離職工程師一起執行它，而不是繞開他。他的 review 留言與 commit 訊息會被原話引用給同事 —— 如果他不會在告別文件裡這樣說，那它就不該出現在手冊裡。
- **本機優先。** 蒐集、索引與產出全部在你的機器上執行。僅有的網路呼叫是發往 GitHub API 以及你設定的 LLM 提供方。選擇 **Ollama**，儲存庫內容將連一個位元組都不會送到任何第三方。
- **索引檔案是敏感的。** `handover-data/*.db` 包含你們團隊的完整 commit 歷史。它預設已被 gitignore；請像對待憑證一樣對待這個檔案。
- **幻覺是 bug，不是小瑕疵。** LLM 輸出必須引用證據引用（evidence refs）；無依據的說法必須標註 *(inference)*。別相信任何你還沒對照證據鏈抽查過的章節。
- **匿名化**（真實姓名 → 角色代碼，用於 HR 情境）已列入路線圖，將在任何團隊/企業版推出之前完成。

## 開發

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

技術棧：TypeScript · Node（內建 `node:sqlite`）· Octokit · 可插拔的 LLM 提供方。CI 在每次 push 時執行 typecheck + 測試 + 建置。

## 路線圖

- [x] 儲存庫腳手架：CLI + Octokit 蒐集 + SQLite 索引 + 風險引擎 + Markdown 手冊
- [x] MCP 伺服器（`handover-mcp`）+ Claude Code 外掛 + Codex prompt
- [ ] 在一個真實的公開儲存庫上端到端跑通 `npx handover-book gen`（MVP，第 1–3 週）
- [ ] PDF / HTML 輸出與翻頁展示
- [ ] 30 天上手路徑 + 寫給未來的信，加入 LLM 風格遷移潤飾（v0.2）
- [ ] 具證據深層連結的本機 web 閱讀器（v0.2）
- [ ] 組織級能力風險地圖（v1.0）

## 命名

npm 套件名稱為 `handover-book`（`handover` 已被一個已棄用的套件佔用）；CLI 指令為 `handover`。最終產品名稱仍未確定 —— 見專案計畫 §8.1。

## 授權條款

[MIT](LICENSE)
