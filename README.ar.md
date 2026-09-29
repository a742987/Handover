[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | **العربية**

> قد تتأخر الترجمات المجتمعية عن نسخة README الإنجليزية في خطوات التثبيت وتفاصيل تدفق البيانات.

# Handover

> **عندما يغادر مطوّر، لا ينبغي أن تغادر معرفته معه.**
> وجِّه Handover إلى اسم مستخدم المهندس المغادر، فيقرأ كل ما التزمه (commit) وراجعه (review) ودافع عنه في النقاشات طوال مسيرته، ثم يُنتج **كتاب التسليم (Handover Book)** — كتابًا مجمّعًا مربوطًا بالأدلة والمراجع — للشخص الذي سيتولى مهامه من بعده.

أمر واحد. يعمل محليًا. التركيب عبر LLM بعيد يتطلب تفعيلًا صريحًا (`--use-llm` أو `HANDOVER_LLM=1`)؛ بدونه لا يغادر أي شيء الجهاز، وتُبنى الفصول 4-6 بشكل حتمي.

```bash
handover gen <username> --repo owner/name
```

---

## لماذا

يخبرك `git blame` بـ*من* كتب سطرًا معيّنًا، لكنه لا يخبرك بـ*لماذا* — ولا بأي الوحدات (modules) ستفقد مراجعها الوحيد بصمت، ولا أي «قرار تصميمي غريب» هو في الحقيقة ركن أساسي يقوم عليه النظام. تعتمد الويكيّات على كتابة الناس طوعًا، وتجتمع اجتماعات المغادرة بعد إعلان الاستقالة وتنتهي قبل أن تُنقل المعرفة.

يغطي Handover الخسائر الضمنية التي لا يغطيها شيء آخر:

1. **بانوراما الشيفرة** — كل وحدة لمسوها، وحالتها، وتاريخها
2. **جرد المعرفة الضمنية** — الوحدات التي كانوا فيها *المؤلف الوحيد* أو *المراجع الوحيد*
3. **أهم 5 مخاطر** — «ما الذي سينكسر عند مغادرتهم»، مرتّبة ومُدرّجة بالدرجات، مع سلسلة أدلة لكل بند
4. **علم الآثار في القرارات** — «لماذا اخترنا هذا حينها»، مع اقتباس نقاشات الـPR/الـissue الفعلية
5. **مسار الثلاثين يومًا** — خطة تعلّم الخليف (الخلف)
6. **الأسئلة ومسودات الإجابات** — ما الذي يجب سؤاله قبل اليوم الأخير، بالإضافة إلى الإجابات التي سجّلها المهندس المغادر بنفسه

## البدء السريع

أقصر مسار — أمر واحد، دون استنساخ المستودع (يُحتاج **Node ≥ 22.13** مع SQLite مدمج — دون تجريف أصلي):

```bash
npm install -g handover-book

# من GitHub (يلزم رمز وصول لحدود معدل طلبات معقولة):
export GITHUB_TOKEN=ghp_...
handover gen <username> --repo owner/name --html

# أو دون رمز وصول ودون شبكة — اقرأ النسخ المحلية لهذا الشخص مباشرة:
handover gen <username> --git-dir ~/work/api --git-dir ~/work/web
```

يوضع الناتج في `handover-data/`:

- `handover-data/<username>.db` — فهرس SQLite المحلي (ملف واحد لكل شخص؛ التشغيلات اللاحقة تزايدية وشبه فورية)
- `handover-data/handover-book-<username>.md` — الكتاب المجمّع (مع `--html`، نسخة HTML أحادية الملف جاهزة للطباعة؛ الطباعة من المتصفح تعطيك PDF)

تفضّل التشغيل من المصدر؟ `git clone https://github.com/a742987/Handover && cd Handover && npm install && npm run dev -- gen <username> --repo owner/name`.

### الأوامر

| الأمر | ماذا يفعل |
|---|---|
| `gen <username> -r owner/name` | جمع ← تحليل ← توليد الكتاب كاملًا |
| `gen <username> -d ~/clone/dir` | الشيء نفسه، لكن من **نسخ git محلية** — دون رمز وصول، ودون شبكة، ويعمل مع GitLab/Gitee أيضًا |
| `collect <username> -r owner/name [-d dir]` | فهرسة التاريخ فقط (تُتخطى الـcommits والـPRs والمراجعات والـissues الموجودة أصلًا في الفهرس) |
| `capture <username>` | اجلس مع المهندس المغادر وسجّل إجاباته هو نفسه؛ تُربط الإجابات في الفصل 6 (`--answers q.json` للوكلاء والسكربتات) |
| `risk <username> [--json]` | طباعة أهم 5 مخاطر من الفهرس المحلي |
| `bus-factor <username>` | نظرة على مستوى الفريق: الوحدات التي لا يلتزم إليها سوى شخص واحد، مع الدمج مع CODEOWNERS عند وجوده في المستودع |
| `gate <username> --files changed.txt` | فحص CI: هل تلمس مجموعة التغييرات هذه وحدات يملكها شخص واحد فقط؟ (`--comment`، و`--fail-on-match`، و`--repo owner/name` لتحديد نطاق فهرس متعدد المستودعات؛ انظر [`examples/sole-owner-gate-action.yml`](examples/sole-owner-gate-action.yml)) |
| `verify <username>` | فحص وجود الاستشهادات: كل مرجع (ref) مستشهد به في الكتاب المولَّد يجب أن يكون موجودًا في الفهرس (رمز الخروج 1 عند وجود مراجع مفقودة — مناسب لـCI، و`--json` للآلات) |
| `render <username>` | إعادة توليد الكتاب من الفهرس، دون الوصول إلى GitHub (الفصول 4-6 تستدعي مزود LLM فقط إذا تم تمرير `--use-llm` وضبط مفتاح API؛ مرّر `-r` لتجاوز المستودعات المسجلة في الفهرس) |

الخيارات الشائعة: `--provider openai|anthropic|ollama`، و`--model <model>`، و`--since <ISO date>` (تُعامل الأوقات بلا منطقة زمنية كأنها بتوقيت UTC)، و`--data-dir <dir>`، و`--refresh` (إعادة جلب ما هو مفهرس فعلًا)، و`--html` (نسخة HTML جاهزة للطباعة من الكتاب)، و`--redact` (يزيل صيغ الأسرار المعروفة من ملخص الـLLM ومن الكتاب؛ **مُفعّل افتراضيًا**)، و`--use-llm` / `HANDOVER_LLM=1` ([README.md#llm-providers](README.md#llm-providers), [.env.example](.env.example))، و`--no-redact` (يبقي نص المستودع كما هو؛ وكذلك `HANDOVER_NO_REDACT=1`)، و`--no-llm` (تخطّي تركيب الـLLM حتى مع ضبط المفتاح — الفصول الحتمية فقط، ولا يغادر الجهاز أي شيء؛ وكذلك `HANDOVER_NO_LLM=1`). يقبل `gen` و`collect` الخيار `--author <identity>` لمطابقة اسم/بريد المهندس المغادر في النسخ المحلية؛ و`capture --list` يطبع الإجابات المسجّلة؛ و`bus-factor` يقبل `--top <n>` و`--window <days>` و`--json` لاستخدامها في CI.

### مزوّدو LLM

الفصول 1–3 تُحسب حتميًا (deterministically) من الفهرس — وهي تعمل دائمًا، بمفتاح API أو بدونه. أما الفصول 4–6 فيُركّبها نموذج لغوي كبير (LLM) فقط عند تمرير `--use-llm`؛ **وفي غياب المفتاح تتراجع إلى ملخصات حتمية** بدلًا من الفشل.

- **Anthropic** — اضبط `ANTHROPIC_API_KEY` (المزوّد الافتراضي)
- **OpenAI** — اضبط `OPENAI_API_KEY` وشغّل بـ`--provider openai`
- **Ollama** — محلي بالكامل ودون مفتاح: شغّل Ollama ثم نفّذ بـ`--provider ollama --use-llm`. الخيار `--use-llm` مطلوب — فـ`--provider` يختار المزوّد فقط، وتركيب الـLLM يجب تفعيله صراحةً.

يعمل كل فصل يعتمد على الـLLM تحت قاعدة صارمة واحدة: **سلسلة أدلة أو لا شيء.** أي ادعاء لا يستطيع النموذج إسناده إلى مرجع commit أو PR أو review أو issue يجب أن يُوسم بـ*(inference)* — فلا مكان في وثيقة تسليم لادعاءات لا يمكن التحقق منها. الفصل 6 لا ينطق أبدًا بلسان المهندس المغادر: مسودات الإجابات تُوسم بأنها مسودات في انتظار التأكيد، وفقط الإجابات المسجّلة عبر `handover capture` تكون بصيغة المتكلم. شغّل `handover verify` للتحقق من كل استشهاد في الكتاب المولَّد.

## كيف يُحتسب الخطر (ولماذا يمكنك الوثوق به)

```
risk = sole_contribution_ratio
     × change_frequency            (last 90 days, normalized)
     × incident_weight             (commits referencing bug-labelled issues)
     × irreplaceability            (sole reviewer +0.5, sole author +0.25)
```

يسرد كل بند من أهم 5 مخاطر الـcommits والمراجعات والـissues المحددة التي تبرر درجته — وكل واحد منها رابط معمّق (deep link) داخل المستودع. الصيغة موجودة في [`src/risk/engine.ts`](src/risk/engine.ts) — اقرأها، وناقشها، واضبطها.

## البنية المعمارية

```
┌──────────────┐   ┌───────────────┐   ┌──────────────┐   ┌───────────────┐
│  Collect     │ → │  Distill      │ → │  Risk Engine │ → │  Render       │
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown +   │
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  print-ready  │
│  Local git   │   │  Q&A capture  │  │  incidents   │   │  HTML book    │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## إضافات المحررات

تشغّل الواجهة البرمجية نفسها ثلاث تكاملات. الطبقة المشتركة هي **خادم MCP مدمج** (`handover-mcp`، يأتي ضمن حزمة npm) يوفّر `handover_generate` و`handover_collect` و`handover_risk` و`handover_capture` و`handover_search` (بحث للقراءة فقط في الأدلة، للأسئلة اللاحقة) و`handover_render` و`handover_verify` (يتحقق من كل إشارة دليل مقابل الفهرس) كأدوات (tools) — ويمكن لأي عميل MCP استخدامه دون الحاجة إلى استدعاء الواجهة من الصدفة (shell).

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — ثبّت الإضافة المرفقة:

```
/plugin marketplace add a742987/Handover
/plugin install handover@handover
```

تُسجّل الإضافة خادم MCP باسم `handover` تلقائيًا (عبر الحقل `mcpServers` في [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json)) وتضيف:

- `/handover:gen <username> --repo owner/name` — خط المعالجة الكامل، ثم ملخص لأهم 5 مخاطر
- `/handover:risk <username>` — أهم 5 مخاطر من فهرس قائم
- مهارة (skill) تعلّم الوكيل متى وكيف يشغّل خط المعالجة ([`plugin/skills/handover/SKILL.md`](plugin/skills/handover/SKILL.md))

**Codex** — سطران فقط:

1. سجّل خادم MCP في `~/.codex/config.toml`:
   ```toml
   [mcp_servers.handover]
   command = "handover-mcp"
   ```
2. انسخ [`codex/handover.md`](codex/handover.md) إلى `~/.codex/prompts/handover.md`، ثم شغّل `/handover <username> --repo owner/name`.

**أي عميل MCP آخر** (Cursor، ZCode، …) — سجّل `handover-mcp` كخادم من نوع stdio؛ الأدوات السبع نفسها في كل مكان.

## الخصوصية والأخلاقيات — اقرأ هذا قبل أن تشغّله لأجل شخص آخر

- **هدية، لا تدقيق.** وُجد Handover ليمتثل الخلف خريطة الطريق، لا ليقيّم الشخص المغادر. شغّله *مع* المهندس المغادر، لا من حوله. فتعليقات مراجعته ورسائل التزاماته ستُقتبس أمام زملائه — ما لا يقوله في وثيقة وداع لا مكان له في الكتاب.
- **المحلية أولًا.** الجمع والفهرسة والتوليد كلها تعمل على جهازك. الاتصالات الشبكية الوحيدة هي إلى واجهة GitHub البرمجية وإلى مزوّد الـLLM الذي ضبطته. اختر **Ollama** فلن يصل بايت واحد من محتوى المستودع إلى أي طرف ثالث.
- **الفهرس مادة حساسة.** يحتوي `handover-data/*.db` على تاريخ الـcommits الكامل لفريقك. وهو مستثنى من Git افتراضيًا (gitignored)؛ تعامل مع الملف كما تتعامل مع بيانات اعتماد (credential).
- **الهلوسة خطأ برمجي، لا صفة عارضة.** يجب أن يستشهد ناتج الـLLM بمراجع الأدلة؛ ويجب وسم الادعاءات غير المسنودة بـ*(inference)*. مسودات الأسئلة والإجابات في الفصل 6 مُوسمة بأنها بانتظار التأكيد — فقط الإجابات المسجّلة عبر `handover capture` هي التي تتحدث بلسان الشخص. شغّل `handover verify` قبل تداول الكتاب. لا تثق بأي فصل لم تتحقق منه عشوائيًا مقابل سلسلة أدلته.
- **إخفاء الهوية** (أسماء حقيقية ← رموز أدوار، لسياقات الموارد البشرية) على خارطة الطريق قبل إطلاق أي نسخة للفرق أو للمؤسسات.

## التطوير

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # dist/
npm run dev -- ...  # run the CLI from source
```

المنصة: TypeScript · Node (بـ`node:sqlite` المدمج) · Octokit · مزوّدو LLM قابلون للتبديل. يُشغّل CI فحص الأنواع والاختبارات والبناء عند كل دفعة (push).

## خارطة الطريق

- [x] هيكل المستودع: الواجهة البرمجية + جمع عبر Octokit + فهرس SQLite + محرك المخاطر + كتاب Markdown
- [x] خادم MCP (`handover-mcp`) + إضافة Claude Code + موجّه Codex
- [x] الجمع من نسخ git المحلية (`--git-dir`) — دون رمز وصول، ودون شبكة
- [x] `handover capture` — أسئلة وإجابات بصيغة المتكلم تُربط في الفصل 6 (CLI + MCP)
- [x] `handover bus-factor` — نظرة على مستوى الفريق مع الدمج مع CODEOWNERS
- [x] نسخة HTML أحادية الملف جاهزة للطباعة (`--html`؛ الطباعة من المتصفح → PDF)
- [x] تكامل CI — `risk --json`، أمر `gate` + مثال سير عمل
- [x] أداة MCP `handover_search` + تنقية الأسرار عبر `--redact`
- [x] الصفحة الأولى بملخص إجراءات يوضح تغطية البيانات، وفحص الاستشهادات `handover verify`، ومفتاح إيقاف صريح `--no-llm`
- [x] نموذج كتاب مرفق في المستودع مع سجل تحقق (`examples/sample-report/`)
- [x] تشغيل من طرف إلى طرف في بيئة نظيفة انطلاقًا من حزمة npm المنشورة: تثبيت → `gen` (Git محلي، `--no-llm`) → `verify` ([سجل التحقق](docs/install-verification.md))
- [ ] الجمع برمز وصول GitHub (`-r owner/name`) من طرف إلى طرف على مستودع عام، وبيئة Unix واحدة في التشغيل النظيف
- [ ] قارئ ويب محلي بروابط أدلة معمّقة (v0.2)
- [ ] خريطة مخاطر القدرات على مستوى المؤسسة (v1.0)

## التسمية

حزمة npm هي `handover-book` (فالاسم `handover` مشغول بحزمة مُهمَلة)؛ أما أمر الواجهة فهو `handover`. اسم المنتج النهائي ما يزال مفتوحًا — انظر §8.1 من خطة المشروع.

## الترخيص

[MIT](LICENSE)
