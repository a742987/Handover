[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | **Монгол** | [العربية](README.ar.md)

# Handover

> **Хөгжүүлэгч хэрэгсэхгүй болвол түүний мэдлэг ч хамт явж болохгүй.**
> Handover-г гарахаар буй инженерийн хэрэглэгчийн нэрээр чиглүүлж өгвөл, энэ нь түүний хийсэн бүх commit, хийсэн бүх review, ямар нэг шийдвэрийн төлөө юу гэж маргаж байсныг бүгдийг уншиж аваад, түүнийг орлох хүнд зориулж нотолгоотой холбоос бүхий бүрэн **Хандoversийн ном**-ыг (Шилжүүлгийн ном) бэлтгэж өгнө.

Нэг командаар. Бүрэн локал. Таны кодын сангийн ямар ч мэдээлэл машинаасаа хэзээ ч гарахгүй.

```bash
handover gen <username> --repo owner/name
```

---

## Яагаад

`git blame` нь мөрийг *хэн* бичсэнийг хэлж өгнө. Гэхдээ *яагаад* гэдгийг хэлж чадахгүй — аль модулиуд гэтэлгээний цорын ганц reviewer-ээ амжаамхгүй алдах болохыг, эсвэл аль «сонин» дизайн шийдвэр бодит байдалд нь барилгын арьс болж байгааг ч хэлэхгүй. Вики хүмүүс сайн дураараа бичихээс хамаарна, харин хөдөлмөрийн гэрээ дуусгах уулзалт нь огцролтыг зарласны дараа эхэлж, мэдлэг шилжихээс өмнө дуусдаг.

Handover нь өөр юу ч хамгаалахгүй байгаа далд хохирлуудыг хамгаална:

1. **Кодын хөргөс (Code Panorama)** — тэд хүрч байсан бүх модуль, тэдгээрийн байдал, тэдгээрийн түүх
2. **Далд мэдлэгийн бүртгэл** — тэд *цорын ганц* author эсвэл *цорын ганц* reviewer байсан модулиуд
3. **эрсдэлийн Топ-5** — «тэд явахад юу эвдрэх вэ» гэдгийг эрэмбэлж оноолж, мөр бүрийг нотолгооны гинжин хэлхээтэйгээр
4. **Шийдвэрийн археологи** — «бид тэр үед юунд ийм сонголт хийсэн бэ» гэдгийг бодит PR/issue маргааныг эш татан харуулж
5. **30 хоногийн зам** — залгамжлагчийн сургах төлөвлөгөө
6. **Ирээдүйд өгөх захидал** — залгамжлагч асуух асуултуудыг гарахуйц хүн өөрөөрөө хариулсан нь

## Хурдан эхлэх

Шаардлага: **Node ≥ 22.5** (SQLite-г өөрөө агуулж ирдэг — native хөрвүүлэлт шаардлагагүй), ухаалаг хурдны хязгаартай ажиллахын тулд GitHub token.

```bash
git clone <this repo> && cd handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

Үр дүн нь `handover-data/` хавтаст унадаг:

- `handover-data/<username>.db` — локал SQLite индекс (хүн бүрд нэг файл; дараагийн ажиллагаанууд нь шинжлэн нэмэх хэлбэртэй, бараг шууд ажиллана)
- `handover-data/handover-book-<username>.md` — бүрсэн ном

### Командууд

| Команд | Юу хийдэг вэ |
|---|---|
| `gen <username> -r owner/name` | цуглуулах → шинжлэх → бүх номыг үүсгэх |
| `collect <username> -r owner/name` | зөвхөн GitHub түүхийг индексжүүлэх (индексэд аль хэдийн байгаа commit, PR, review, issue-г алгасна) |
| `risk <username>` | локал индексээс эрсдэлийн Топ-5-ыг хэвлэх |
| `render <username>` | индексээс номыг дахин үүсгэх (сүлжээ ашиглахгүй; repository-г индексээс уншина, `-r`-ээр дарж бичиж болно) |

Түгээмэл флагууд: `--provider openai|anthropic|ollama`, `--model <model>`, `--since <ISO date>`, `--data-dir <dir>`, `--refresh` (индексжүүлсэн зүйлийг дахин татах).

### LLM provider-ууд

1–3-р бүлгүүд нь индексээс тодорхойлогдох (детерминист) аргаар бодно — API түлхүүртэй ч үгүй эсэхээс үл хамааран үргэлж ажиллана. 4–6-р бүлгүүдийг LLM синтездэж бэлтгэнэ; **түлхүүргүй бол алга болохын оронд тодорхойлогдох (детерминист) хураангуйлалд шилжинэ**.

- **Anthropic** — `ANTHROPIC_API_KEY` тавих (өгөгдмөл provider)
- **OpenAI** — `OPENAI_API_KEY` тавиад, `--provider openai`-гээр ажиллуулах
- **Ollama** — бүрэн локал, түлхүүргүй: Ollama-г эхлүүлээд `--provider ollama`-гээр ажиллуулах

LLM бүхий бүх бүлэг нэг хатуу дүрмийн дор ажиллана: **нотолгооны гинжгүй бол юу ч биш.** Модел commit, PR, review, issue-ийн эш татаар дэмжиж чадахгүй мэдэгдэл бүрийг *(inference)* гэж тэмдэглэх ёстой — нотолж болохгүй мэдэгдэл шилжүүлгийн баримт бичигт огт байх ёсгүй.

## Эрсдэл хэрхэн оноолох вэ (яагаад итгэж болох вэ)

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

эрсдэлийн Топ-5 мөр бүр өөрийн оноог буруушааж буй нарийн commit, review, issue-үүдийг бүртгэдэг — аль нь ч repository руу шууд холбогдох гүн холбоос юм. Томьёо нь [`src/risk/engine.ts`](src/risk/engine.ts)-д байдаг — уншаарай, эргэлзээрийг шалгаарай, өөрөө тааруулаарай.

## Архитектур

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## Editor plugin-ууд

Нэг ижил CLI нь гурван интеграцийг ажиллуулдаг. Нийтлэг давхарга нь **суурин MCP сервер** (`handover-mcp`, npm багцад хамт ирдэг) бөгөөд энэ нь `handover_generate`, `handover_collect`, `handover_risk`, `handover_render` гэсэн дөрвөн tool-г илгадаг — ямар ч MCP client CLI рүү нээлттэй shell дуудахгүйгээр шууд ашиглаж болно.

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — багцалсан plugin-г суулгана:

```
/plugin marketplace add <this-repo>
/plugin install handover@handover
```

Plugin нь `handover` MCP серверийг автоматаар бүртгэдэг ([`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json) дахь `mcpServers` талбараар) бөгөөд дараахыг нэмдэг:

- `/handover:gen <username> --repo owner/name` — бүрэн шугам, дараа нь эрсдэлийн Топ-5-ын хураангуй
- `/handover:risk <username>` — бэлэн индексээс эрсдэлийн Топ-5
- шугамыг хэзээ, хэрхэн ажиллуулахыг agent-д зааж өгөх skill ([`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md))

**Codex** — хоёр мөр:

1. MCP серверийг `~/.codex/config.toml`-д бүртгэх:
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. [`codex/handover.md`](codex/handover.md)-г `~/.codex/prompts/handover.md` руу хуулаад, `/handover <username> --repo owner/name` командыг ажиллуулна.

**Бусад ямар ч MCP client** (Cursor, ZCode, …) — `handover-mcp`-г stdio сервер болгон бүртгээрэй; дөрвөн tool бүгд газар дамжин ижил.

## Нууцлал ба ёс зүй — хэн нэгний төлөө ажиллуулахаасаа өмнө үүнийг унш

- **Бэлэг, биш шалгалт.** Handover нь залгамжлагчид газрын зургийг өгөх зорилготой — гарах хүнийг үнэлэх зорилгоор огт биш. Гарах инженертэй *хамт* ажиллуул, далдлаар биш. Түүний review тайлбар, commit зурвас хамтран ажиллагсдад эш татагдана — салахын баримт бичигт хэлэхгүй байх зүйл бол номд багтаагүй.
- **Локалд түшиглэсэн.** Цуглуулга, индексжүүлэлт, синтез, render бүгд таны машин дээр ажиллана. Цөөхөн сүлжээний дуудлага нь GitHub-ий API, таны тохируулсан LLM provider руу л очно. **Ollama**-г сонговол repository-ийн нэг ч byte гуравдагч этгээдэд очихгүй.
- **Индекс нь мэдрэг материал.** `handover-data/*.db` нь таны багийн бүрэн commit түүхийг агуулна. Анхдагчаар gitignored болгосон; энэ файлыг credential шиг хамгаалаарай.
- **Худал дурдалт (hallucination) нь жижиг зүйл биш, bug юм.** LLM-ий гаралт нотолгооны эш таталттай байх ёстой; дэмжлэггүй мэдэгдлийг *(inference)* гэж тэмдэглэсэн байх ёстой. Нотолгооны гинжтэй нь нягталж үзээгүй бүлгийг бүү итгэ.
- **Нэр нуух (Anonymization)** (жинхэнэ нэрс → ажлын код, HR-ийн хэрэглээнд зориулж) нь багийн/байгууллагын түвшний хувилбар гарахын өмнө roadmap дээр бий.

## Хөгжүүлэлт

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

Технологи: TypeScript · Node (суурин `node:sqlite`) · Octokit · солих боломжтой LLM provider-ууд. CI нь push бүр дээр typecheck + тест + build-ыг ажиллуулдаг.

## Хөгжлийн төлөвлөгөө (Roadmap)

- [x] Repository-ийн суурь бүтэц: CLI + Octokit цуглуулга + SQLite индекс + эрсдэлийн engine + Markdown ном
- [x] MCP сервер (`handover-mcp`) + Claude Code plugin + Codex prompt
- [ ] Жинхэнэ нийтийн repository дээр `npx handover-book gen` бүрэн гүйцэд ажиллах (MVP, 1–3-р долоо хоног)
- [ ] PDF / HTML гаралт, хуудас эргүүлэх демо
- [ ] 30 хоногийн зам + Ирээдүйд өгөх захидал — LLM хэлбэржүүлэлтийн нарийн болгохоор (v0.2)
- [ ] Нотолгооны гүн холбоос бүхий локал вэб уншигч (v0.2)
- [ ] Байгууллагаар дамжсан чадварын эрсдэлийн зураглал (v1.0)

## Нэрлэлт

npm багц нь `handover-book` (`handover` нэрийг хуучирсан багц эзэлсэн); CLI команд нь `handover`. Эцсийн бүтээлийн нэр хараахан шийдэгдээгүй — төслийн төлөвлөгөөний §8.1-ыг харна уу.

## Лиценз

[MIT](LICENSE)
