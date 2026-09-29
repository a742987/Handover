[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **日本語** | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

> コミュニティ翻訳は、インストール手順とデータフローの説明において英語版 README に追いついていない場合があります。

# Handover（引き継ぎマニュアル）

> **開発者が退職しても、その知識まで連れていかれてはならない。**
> 退職するエンジニアのユーザー名を Handover に渡せば、その人がコミットし、レビューし、そして議論してきたすべてを読み取り —— 後任者のための、証拠へのリンクが付いた製本済みの **Handover Book（引き継ぎマニュアル）** を生成します。

コマンド一つ。ローカルで動作。LLM プロバイダーが設定されている場合（デフォルト）、収集されたリポジトリのコンテンツは合成のためにそのプロバイダーに送信されます。API キーが設定されていない場合、すべては決定論的にローカルで処理されます。

```bash
handover gen <username> --repo owner/name
```

---

## なぜ必要か

`git blame` はある行を*誰が*書いたかは教えてくれますが、*なぜ*そう書いたかは教えてくれません。どのモジュールが唯一のレビュワーを静かに失うのか、どの「奇妙な」設計判断が実は土台を支えているのかも分かりません。Wiki は人々が自発的に書き続けることに依存し、退職面談は辞表の公表後に始まり、知識の受け渡しが完了する前に終わってしまいます。

Handover は、他のどのツールもカバーできない暗黙知の損失をカバーします:

1. **コード・パノラマ** — その人が触れたすべてのモジュール、その状態と履歴
2. **暗黙知インベントリ** — その人が*唯一の*作成者または*唯一の*レビュワーだったモジュール
3. **リスク Top 5** — 「彼らがいなくなったら何が壊れるか」を順位付けしスコア化、各項目に証拠チェーンを添付
4. **意思決定の考古学** — 「なぜ当時この選択をしたのか」、実際の PR/issue での議論をそのまま引用
5. **30 日間の学習パス** — 後任者の学習プラン
6. **質問と回答ドラフト** — 最終出社日の前に尋ねるべき質問と、退職するエンジニア本人が記録した回答

## クイックスタート

要件：**Node ≥ 22.13**（SQLite が組み込み — ネイティブコンパイル不要）。GitHub から収集する場合にのみ、適度なレート制限のための GitHub トークンが必要です。

```bash
npm install -g handover-book

# GitHub から収集する場合（適度なレート制限にはトークンが必要）:
export GITHUB_TOKEN=ghp_...
handover gen <username> --repo owner/name --html

# またはトークン不要・ネットワーク不要で — 本人のローカルクローンを直接読む:
handover gen <username> --git-dir ~/work/api --git-dir ~/work/web
```

ソースから実行したい場合: `git clone https://github.com/a742987/Handover && cd Handover && npm install && npm run dev -- gen <username> --repo owner/name`。

出力は `handover-data/` に保存されます:

- `handover-data/<username>.db` — ローカルの SQLite インデックス（1 人につき 1 ファイル。2 回目以降の実行は増分更新でほぼ瞬時に完了）
- `handover-data/handover-book-<username>.md` — 製本済みのマニュアル（`--html` を付けると、印刷に適した単一ファイルの HTML ツインも出力 — ブラウザの印刷で PDF が得られます）

### コマンド

| コマンド | 説明 |
|---|---|
| `gen <username> -r owner/name` | 収集 → 分析 → マニュアル全体をレンダリング |
| `gen <username> -d ~/clone/dir` | 同じ処理を**ローカルの git クローン**から直接実行 — トークン不要、ネットワーク不要、GitLab/Gitee でも動作 |
| `collect <username> -r owner/name [-d dir]` | 履歴のインデックス化のみ（インデックス済みの commit、PR、レビュー、issue はスキップされます） |
| `capture <username>` | 退職するエンジニア本人と一緒に座り、本人自身の回答を記録する。その回答は第 6 章に組み込まれる（`--answers q.json` はエージェントやスクリプト向け） |
| `risk <username> [--json]` | ローカルインデックスからリスク Top 5 を表示 |
| `bus-factor <username>` | チームビュー: 一人だけが commit しているモジュールはどれか。リポジトリに CODEOWNERS があればそれを統合して表示 |
| `gate <username> --files changed.txt` | CI チェック: この変更セットは単独所有モジュールに触れるか？（`--comment`、`--fail-on-match`、`--repo owner/name` で複数リポジトリのインデックスの対象を絞れます。[`examples/sole-owner-gate-action.yml`](examples/sole-owner-gate-action.yml) を参照） |
| `verify <username>` | 引用の存在チェック: 製本されたマニュアルが引用するすべての参照がインデックスに実在することを確認（欠落があれば終了コード 1 — CI で使いやすい。`--json` はマシン向け） |
| `render <username>` | インデックスからマニュアルを再レンダリング（GitHub への接続なし。第 4-6 章は API キーが設定されている場合にのみ LLM プロバイダーを呼び出します。`-r` でインデックスに記録されたリポジトリを上書き可能） |

よく使うフラグ: `--provider openai|anthropic|ollama`、`--model <model>`、`--since <ISO date>`（タイムゾーンなしの時刻は UTC として扱われます）、`--data-dir <dir>`、`--refresh`（インデックス済みの内容を再取得）、`--html`（印刷に適した HTML ツイン）、`--redact`（LLM ダイジェストとマニュアルから既知のシークレット形式を除去。`HANDOVER_REDACT=1` でも可）、`--no-llm`（キーが設定されていても LLM 合成をスキップ — 決定論的な章のみで、何もマシンの外に出ません。`HANDOVER_NO_LLM=1` でも可）。`gen` と `collect` は `--author <identity>` を受け付け、ローカルクローン内で退職するエンジニアの名前/メールアドレスを照合します。`capture --list` は記録済みの回答を出力します。`bus-factor` は CI 向けに `--top <n>`、`--window <days>`、`--json` を受け付けます。

### LLM プロバイダー

第 1〜3 章はインデックスから決定論的に計算されます — API キーの有無にかかわらず常に動作します。第 4〜6 章は LLM によって生成されますが、**キーがなければ決定論的な要約にフォールバック**し、失敗することはありません。

- **Anthropic** — `ANTHROPIC_API_KEY` を設定（デフォルトのプロバイダー）
- **OpenAI** — `OPENAI_API_KEY` を設定し、`--provider openai` を付けて実行
- **Ollama** — 完全ローカル、キー不要: Ollama を起動して `--provider ollama` を付けて実行

すべての LLM 章には一つの厳格なルールが適用されます: **証拠チェーンがあるか、何も書かないか。**モデルが commit、PR、レビュー、issue の参照で裏付けられない主張には *(inference)*（推論）のラベルを付けなければなりません — 検証できない断言は引き継ぎ文書に置く場所がありません。

## リスクのスコア計算方法（そしてそれを信頼できる理由）

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

リスク Top 5 の各項目には、そのスコアを裏付ける commit・レビュー・issue が正確に列挙されます — どれもリポジトリへのディープリンクです。この数式は [`src/risk/engine.ts`](src/risk/engine.ts) にあります — 読んで、疑って、調整してください。

## アーキテクチャ

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown +   │
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  print-ready  │
│  Local git   │   │  Q&A capture  │  │  incidents   │   │  HTML book    │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## エディタプラグイン

同一の CLI が 3 つの統合を駆動します。共通レイヤーは**組み込みの MCP サーバー**（`handover-mcp`、npm パッケージに同梱）で、`handover_generate`、`handover_collect`、`handover_risk`、`handover_capture`、`handover_search`（追問に答えるための読み取り専用の証拠検索）、`handover_render` をツールとして公開します — CLI をシェル経由で呼び出すことなく、どの MCP クライアントでも利用できます。

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — バンドルされたプラグインをインストール:

```
/plugin marketplace add a742987/Handover
/plugin install handover@handover
```

このプラグインは [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json) の `mcpServers` フィールドを通じて `handover` MCP サーバーを自動登録し、次のものを追加します:

- `/handover:gen <username> --repo owner/name` — フルパイプラインの後、要約されたリスク Top 5 を表示
- `/handover:risk <username>` — 既存のインデックスからリスク Top 5 を表示
- パイプラインをいつ・どう実行するかをエージェントに教える skill（[`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md)）

**Codex** — 2 行だけ:

1. `~/.codex/config.toml` に MCP サーバーを登録:
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. [`codex/handover.md`](codex/handover.md) を `~/.codex/prompts/handover.md` にコピーし、`/handover <username> --repo owner/name` を実行。

**その他の MCP クライアント**（Cursor、ZCode など）— `handover-mcp` を stdio サーバーとして登録するだけ。どこでも同じ 6 つのツールが使えます。

## プライバシーと倫理 — 誰かのために実行する前に読んでください

- **監査ではなく、贈り物。** Handover は後任者に地図を手渡すために存在し、退職する人を評価するためでは決してありません。退職するエンジニアと*一緒に*実行してください。彼らのいないところで実行しないでください。そのレビューコメントや commit メッセージは同僚にそのまま引用されます — 送別文書で言えないようなことは、マニュアルに載せるべきではありません。
- **ローカルファースト。** 収集、インデックス化、レンダリングはすべてあなたのマシン上で実行されます。ネットワーク接続は GitHub API と設定済みの LLM プロバイダーへの呼び出しのみ。**Ollama** を選べば、リポジトリの内容は 1 バイトも第三者に届きません。
- **インデックスは機密情報です。** `handover-data/*.db` にはチームの完全な commit 履歴が含まれます。デフォルトで gitignore されています。このファイルは認証情報（クレデンシャル）と同じように扱ってください。
- **ハルシネーションはバグであり、仕様ではありません。** LLM の出力には証拠参照（evidence refs）の引用が必須で、裏付けのない主張には *(inference)* のラベルを付けなければなりません。証拠チェーンと照合して確認していない章は信じないでください。第 6 章の Q&A ドラフトは確認待ちとして明示され、本人の声で語るのは `handover capture` で記録された回答だけです。
- **匿名化**（実名 → 役割コード、HR 向け）は、チーム/エンタープライズ版の提供前に実装するロードマップ項目です。

## 開発

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

スタック: TypeScript · Node（組み込み `node:sqlite`）· Octokit · プラグイン可能な LLM プロバイダー。CI はすべての push で typecheck + テスト + ビルドを実行します。

## ロードマップ

- [x] リポジトリの雛形: CLI + Octokit 収集 + SQLite インデックス + リスクエンジン + Markdown マニュアル
- [x] MCP サーバー（`handover-mcp`）+ Claude Code プラグイン + Codex プロンプト
- [x] ローカル git クローンからの収集（`--git-dir`）— トークン不要、ネットワーク不要
- [x] `handover capture` — 第一人称の Q&A を第 6 章に組み込み（CLI + MCP）
- [x] `handover bus-factor` — CODEOWNERS 統合付きのチームビュー
- [x] 印刷に適した単一ファイル HTML ツイン（`--html`；ブラウザの印刷 → PDF）
- [x] CI 統合 — `risk --json`、`gate` コマンド + サンプルワークフロー
- [x] `handover_search` MCP ツール + `--redact` シークレット除去
- [x] データカバー状況を示すアクションサマリーの先頭ページ、`handover verify` の引用チェック、明示的な `--no-llm` オフスイッチ
- [x] 検証記録付きのコミット済みサンプルマニュアル（`examples/sample-report/`）
- [x] 公開済み npm パッケージからのクリーン環境エンドツーエンド: インストール → `gen`（ローカル Git、`--no-llm`）→ `verify`（[検証記録](docs/install-verification.md)）
- [ ] 公開リポジトリでの GitHub トークン収集（`-r owner/name`）のエンドツーエンド実行、およびクリーン実行での Unix 環境 1 つ
- [ ] 証拠ディープリンク付きのローカル web リーダー（v0.2）
- [ ] 組織全体のケイパビリティ・リスクマップ（v1.0）

## 名前について

npm パッケージ名は `handover-book` です（`handover` は非推奨パッケージが占有しています）。CLI コマンドは `handover` です。最終的な製品名はまだ未定 — プロジェクト計画の §8.1 を参照してください。

## ライセンス

[MIT](LICENSE)
