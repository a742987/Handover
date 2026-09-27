[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | **日本語** | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | [العربية](README.ar.md)

# Handover（引き継ぎマニュアル）

> **開発者が退職しても、その知識まで連れていかれてはならない。**
> 退職するエンジニアのユーザー名を Handover に渡せば、その人がコミットし、レビューし、そして議論してきたすべてを読み取り —— 後任者のための、証拠へのリンクが付いた製本済みの **Handover Book（引き継ぎマニュアル）** を生成します。

コマンド一つ。完全ローカル。コードベースに関する情報が、あなたのマシンの外に出ることは一切ありません。

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
6. **未来への手紙** — 後任者が抱くであろう疑問に、退職する開発者本人の声で回答

## クイックスタート

要件：**Node ≥ 22.5**（SQLite が組み込み — ネイティブコンパイル不要）、および適度なレート制限のための GitHub トークン。

```bash
git clone <this repo> && cd handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

出力は `handover-data/` に保存されます:

- `handover-data/<username>.db` — ローカルの SQLite インデックス（1 人につき 1 ファイル。2 回目以降の実行は増分更新でほぼ瞬時に完了）
- `handover-data/handover-book-<username>.md` — 製本済みのマニュアル

### コマンド

| コマンド | 説明 |
|---|---|
| `gen <username> -r owner/name` | 収集 → 分析 → マニュアル全体をレンダリング |
| `collect <username> -r owner/name` | GitHub 履歴のインデックス化のみ（インデックス済みの commit、PR、レビュー、issue はスキップされます） |
| `risk <username>` | ローカルインデックスからリスク Top 5 を表示 |
| `render <username>` | インデックスからマニュアルを再レンダリング（ネットワーク接続なし。リポジトリ情報はインデックスから読み込まれ、`-r` で上書き可能） |

よく使うフラグ: `--provider openai|anthropic|ollama`、`--model <model>`、`--since <ISO date>`、`--data-dir <dir>`、`--refresh`（インデックス済みの内容を再取得）。

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
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## エディタプラグイン

同一の CLI が 3 つの統合を駆動します。共通レイヤーは**組み込みの MCP サーバー**（`handover-mcp`、npm パッケージに同梱）で、`handover_generate`、`handover_collect`、`handover_risk`、`handover_render` をツールとして公開します — CLI をシェル経由で呼び出すことなく、どの MCP クライアントでも利用できます。

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — バンドルされたプラグインをインストール:

```
/plugin marketplace add <this-repo>
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

**その他の MCP クライアント**（Cursor、ZCode など）— `handover-mcp` を stdio サーバーとして登録するだけ。どこでも同じ 4 つのツールが使えます。

## プライバシーと倫理 — 誰かのために実行する前に読んでください

- **監査ではなく、贈り物。** Handover は後任者に地図を手渡すために存在し、退職する人を評価するためでは決してありません。退職するエンジニアと*一緒に*実行してください。彼らのいないところで実行しないでください。そのレビューコメントや commit メッセージは同僚にそのまま引用されます — 送別文書で言えないようなことは、マニュアルに載せるべきではありません。
- **ローカルファースト。** 収集、インデックス化、生成、レンダリングはすべてあなたのマシン上で実行されます。ネットワーク接続は GitHub API と設定済みの LLM プロバイダーへの呼び出しのみ。**Ollama** を選べば、リポジトリの内容は 1 バイトも第三者に届きません。
- **インデックスは機密情報です。** `handover-data/*.db` にはチームの完全な commit 履歴が含まれます。デフォルトで gitignore されています。このファイルは認証情報（クレデンシャル）と同じように扱ってください。
- **ハルシネーションはバグであり、仕様ではありません。** LLM の出力には証拠参照（evidence refs）の引用が必須で、裏付けのない主張には *(inference)* のラベルを付けなければなりません。証拠チェーンと照合して確認していない章は信じないでください。
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
- [ ] 実在する公開リポジトリでの `npx handover-book gen` のエンドツーエンド実行（MVP、第 1〜3 週）
- [ ] PDF / HTML 出力とページめくりデモ
- [ ] 30 日間の学習パス + 未来への手紙、LLM によるスタイル転写の仕上げ付き（v0.2）
- [ ] 証拠ディープリンク付きのローカル web リーダー（v0.2）
- [ ] 組織全体のケイパビリティ・リスクマップ（v1.0）

## 名前について

npm パッケージ名は `handover-book` です（`handover` は非推奨パッケージが占有しています）。CLI コマンドは `handover` です。最終的な製品名はまだ未定 — プロジェクト計画の §8.1 を参照してください。

## ライセンス

[MIT](LICENSE)
