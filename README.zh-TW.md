[English](README.md) | [简体中文](README.zh-CN.md) | **繁體中文** | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

> 社群翻譯在安裝步驟與資料流說明上可能落後於英文版 README。

# Handover（交接手冊）

> **當一位開發者離開時，他的知識不應該跟著離開。**
> 把離職工程師的帳號名稱交給 Handover，它會讀取他提交過、審核過、為之爭論過的一切 —— 然後為接任者產出一本裝訂成冊、證據可溯的 **Handover Book（交接手冊）**。

一行指令。在本機執行。遠端 LLM 合成需明確開啟（`--use-llm` 或 `HANDOVER_LLM=1`）；未開啟時，任何內容都不會離開本機，第 4-6 章以確定性方式生成。

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
6. **問題與答案草稿** —— 交接前該問什麼，加上離職工程師本人錄製的第一人稱回答

## 快速開始

最短路徑 —— 一行指令，無需 clone 儲存庫（需要 Node ≥ 22.13）：

```bash
npm install -g handover-book

# 從 GitHub 蒐集（需要 token 以取得合理的速率限制）：
export GITHUB_TOKEN=ghp_...
handover gen <username> --repo owner/name --html

# 或者完全不用 token、不用連網 —— 直接讀取他的本機 git clone：
handover gen <username> --git-dir ~/work/api --git-dir ~/work/web
```

輸出位於 `handover-data/`：

- `handover-data/<username>.db` —— 本機 SQLite 索引（每人一個檔案；第二次執行增量更新，幾乎瞬間完成）
- `handover-data/handover-book-<username>.md` —— 裝訂成冊的手冊（加 `--html` 會同時輸出可直接列印的單一檔案 HTML —— 用瀏覽器列印即得 PDF）

想從原始碼執行？`git clone https://github.com/a742987/Handover && cd Handover && npm install && npm run dev -- gen <username> --repo owner/name`。

### 指令

| 指令 | 作用 |
|---|---|
| `gen <username> -r owner/name` | 蒐集 → 分析 → 產出完整手冊 |
| `gen <username> -d ~/clone/dir` | 同樣流程，但改為讀取**本機 git clone** —— 無需 token、無需連網，GitLab/Gitee 也適用 |
| `collect <username> -r owner/name [-d dir]` | 僅索引歷史（索引中已有的 commit、PR、review 與 issue 會被略過） |
| `capture <username>` | 與離職工程師本人對談，錄下他的第一人稱回答並裝訂進第 6 章（`--answers q.json` 供 agent/腳本非互動使用） |
| `risk <username> [--json]` | 從本機索引列印風險 Top 5 |
| `bus-factor <username>` | 團隊視角：哪些模組只有一個人在提交，並在儲存庫有 CODEOWNERS 時將其合併 |
| `gate <username> --files changed.txt` | CI 檢查：這組變更是否觸及僅由單人持有的模組？（`--comment`、`--fail-on-match`、`--repo owner/name` 用於限定多儲存庫索引；範例見 [`examples/sole-owner-gate-action.yml`](examples/sole-owner-gate-action.yml)） |
| `verify <username>` | 引用存在性檢查：手冊中引用的每一條證據 ref 都必須存在於索引中（有缺失時結束代碼為 1 —— 可用於 CI，`--json` 供機器讀取） |
| `render <username>` | 從索引重新產出手冊，不連上 GitHub（第 4-6 章僅在傳入 `--use-llm` 且設定了 API 金鑰時才呼叫 LLM 提供方；可用 `-r` 覆寫索引中記錄的儲存庫） |

常用參數：`--provider openai|anthropic|ollama`、`--model <model>`、`--since <ISO date>`（省略時區的時刻按 UTC 處理）、`--data-dir <dir>`、`--refresh`（重新抓取已索引的內容）、`--html`（可直接列印的 HTML 雙胞胎）、`--redact`（在送入 LLM 摘要與成書前清除已知格式的機密；**預設開啟**）、`--use-llm` / `HANDOVER_LLM=1` ([README.md#llm-providers](README.md#llm-providers), [.env.example](.env.example))、`--no-redact`（保留倉庫文字原樣；也可用 `HANDOVER_NO_REDACT=1`）、`--no-llm`（即使設定了金鑰也跳過 LLM 合成 —— 僅輸出確定性章節，任何內容都不離開本機；也可用 `HANDOVER_NO_LLM=1`）。`gen` 與 `collect` 還接受 `--author <identity>`，用於在本機 git clone 中比對離職者的姓名/電子郵件；`capture --list` 列出已錄製的回答；`bus-factor` 支援 `--top <n>`、`--window <days>` 與 `--json`（供 CI 使用）。

### LLM 提供方

第 1–3 章直接從索引以確定性方式計算 —— 無論有沒有 API key 都能正常運作。第 4–6 章僅在傳入 `--use-llm` 時由 LLM 生成（**沒有 key 時會退回確定性摘要**，而不會報錯失敗）。

- **Anthropic** —— 設定 `ANTHROPIC_API_KEY`（預設提供方）
- **OpenAI** —— 設定 `OPENAI_API_KEY`，並以 `--provider openai` 執行
- **Ollama** —— 完全本機、無需 key：啟動 Ollama 後以 `--provider ollama --use-llm` 執行。`--use-llm` 是必需的 —— `--provider` 只負責選擇提供方，LLM 合成本身必須顯式開啟。

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
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown +   │
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  print-ready  │
│  Local git   │   │  Q&A capture  │  │  incidents   │   │  HTML book    │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## 編輯器外掛

同一個 CLI 驅動三套整合。共通層是一個**內建 MCP 伺服器**（`handover-mcp`，隨 npm 套件一併發布），它把 `handover_generate`、`handover_collect`、`handover_risk`、`handover_capture`、`handover_search`（唯讀證據檢索，用於回答追問）、`handover_render` 與 `handover_verify`（對照索引校驗每條證據引用）公開為工具 —— 任何 MCP 用戶端都可以直接使用，無需呼叫 CLI。

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

**其他任何 MCP 用戶端**（Cursor、ZCode 等）—— 把 `handover-mcp` 註冊為 stdio 伺服器即可；到處都是同樣的七個工具。

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
- [x] 本機 git clone 蒐集（`--git-dir`）—— 無需 token、無需連網
- [x] `handover capture` —— 第一人稱問答裝訂進第 6 章（CLI + MCP）
- [x] `handover bus-factor` —— 團隊視角，合併 CODEOWNERS
- [x] 可直接列印的單一檔案 HTML 雙胞胎（`--html`；瀏覽器列印即得 PDF）
- [x] CI 整合 —— `risk --json`、`gate` 指令 + 範例工作流程
- [x] `handover_search` MCP 工具 + `--redact` 機密清除
- [x] 行動摘要首頁（含資料涵蓋說明）、`handover verify` 引用檢查、明確的 `--no-llm` 關閉開關
- [x] 收錄於儲存庫的範例手冊與核驗記錄（`examples/sample-report/`）
- [x] 從已發布的 npm 套件在乾淨環境端到端跑通：安裝 → `gen`（本機 Git，`--no-llm`）→ `verify`（[驗證記錄](docs/install-verification.md)）
- [ ] 以 GitHub token 在公開儲存庫上端到端跑通蒐集路徑（`-r owner/name`），並在乾淨環境中涵蓋一個 Unix 環境
- [ ] 具證據深層連結的本機 web 閱讀器（v0.2）
- [ ] 組織級能力風險地圖（v1.0）

## 命名

npm 套件名稱為 `handover-book`（`handover` 已被一個已棄用的套件佔用）；CLI 指令為 `handover`。最終產品名稱仍未確定 —— 見專案計畫 §8.1。

## 授權條款

[MIT](LICENSE)
