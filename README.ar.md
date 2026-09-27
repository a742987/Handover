[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Deutsch](README.de.md) | [Монгол](README.mn.md) | **العربية**

# Handover

> **عندما يغادر مطوّر، لا ينبغي أن تغادر معرفته معه.**
> وجِّه Handover إلى اسم مستخدم المهندس المغادر، فيقرأ كل ما التزمه (commit) وراجعه (review) ودافع عنه في النقاشات طوال مسيرته، ثم يُنتج **كتاب التسليم (Handover Book)** — كتابًا مجمّعًا مربوطًا بالأدلة والمراجع — للشخص الذي سيتولى مهامه من بعده.

أمر واحد. محلي بالكامل. لا شيء عن قاعدة الشيفرة الخاصة بك يغادر جهازك أبدًا.

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
6. **رسالة إلى المستقبل** — الأسئلة التي سيسألها الخلف، مُجابةً بصوت المطوّر المغادر نفسه

## البدء السريع

المتطلبات: **Node ≥ 22.5** (يأتي بـSQLite مدمجًا — دون تجريف أصلي)، ورمز وصول (token) من GitHub لضمان حدود معدل معقولة.

```bash
git clone <this repo> && cd handover
npm install

export GITHUB_TOKEN=ghp_...          # repo scope for private repos
npm run dev -- gen <username> --repo owner/name
```

يوضع الناتج في `handover-data/`:

- `handover-data/<username>.db` — فهرس SQLite المحلي (ملف واحد لكل شخص؛ التشغيلات اللاحقة تزايدية وشبه فورية)
- `handover-data/handover-book-<username>.md` — الكتاب المجمّع

### الأوامر

| الأمر | ماذا يفعل |
|---|---|
| `gen <username> -r owner/name` | جمع ← تحليل ← توليد الكتاب كاملًا |
| `collect <username> -r owner/name` | فهرسة تاريخ GitHub فقط (تُتخطى الـcommits والـPRs والمراجعات والـissues الموجودة أصلًا في الفهرس) |
| `risk <username>` | طباعة أهم 5 مخاطر من الفهرس المحلي |
| `render <username>` | إعادة توليد الكتاب من الفهرس (دون شبكة؛ تُقرأ المستودعات من الفهرس، ومرّر `-r` لتجاوز ذلك) |

الخيارات الشائعة: `--provider openai|anthropic|ollama`، و`--model <model>`، و`--since <ISO date>`، و`--data-dir <dir>`، و`--refresh` (إعادة جلب ما هو مفهرس فعلًا).

### مزوّدو LLM

الفصول 1–3 تُحسب حتميًا (deterministically) من الفهرس — وهي تعمل دائمًا، بمفتاح API أو بدونه. أما الفصول 4–6 فيُركّبها نموذج لغوي كبير (LLM)؛ **وفي غياب المفتاح تتراجع إلى ملخصات حتمية** بدلًا من الفشل.

- **Anthropic** — اضبط `ANTHROPIC_API_KEY` (المزوّد الافتراضي)
- **OpenAI** — اضبط `OPENAI_API_KEY` وشغّل بـ`--provider openai`
- **Ollama** — محلي بالكامل ودون مفتاح: شغّل Ollama ثم نفّذ بـ`--provider ollama`

يعمل كل فصل يعتمد على الـLLM تحت قاعدة صارمة واحدة: **سلسلة أدلة أو لا شيء.** أي ادعاء لا يستطيع النموذج إسناده إلى مرجع commit أو PR أو review أو issue يجب أن يُوسم بـ*(inference)* — فلا مكان في وثيقة تسليم لادعاءات لا يمكن التحقق منها.

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
│  GitHub API  │   │  LLM synthesis│   │  sole-contrib│   │  Markdown book│
│  (Octokit)   │   │  topic clusters│  │  change freq │   │  (PDF/HTML:   │
│              │   │  Q&A extraction│  │  incidents   │   │   on roadmap) │
└──────────────┘   └───────────────┘   └──────────────┘   └───────────────┘
          └────────── SQLite index (one file per person, cacheable) ─────────┘
```

## إضافات المحررات

تشغّل الواجهة البرمجية نفسها ثلاث تكاملات. الطبقة المشتركة هي **خادم MCP مدمج** (`handover-mcp`، يأتي ضمن حزمة npm) يوفّر `handover_generate` و`handover_collect` و`handover_risk` و`handover_render` كأدوات (tools) — ويمكن لأي عميل MCP استخدامه دون الحاجة إلى استدعاء الواجهة من الصدفة (shell).

```bash
npm install -g handover-book   # puts both `handover` and `handover-mcp` on PATH
```

**Claude Code** — ثبّت الإضافة المرفقة:

```
/plugin marketplace add <this-repo>
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

**أي عميل MCP آخر** (Cursor، ZCode، …) — سجّل `handover-mcp` كخادم من نوع stdio؛ الأدوات الأربع نفسها في كل مكان.

## الخصوصية والأخلاقيات — اقرأ هذا قبل أن تشغّله لأجل شخص آخر

- **هدية، لا تدقيق.** وُجد Handover ليمتثل الخلف خريطة الطريق، لا ليقيّم الشخص المغادر. شغّله *مع* المهندس المغادر، لا من حوله. فتعليقات مراجعته ورسائل التزاماته ستُقتبس أمام زملائه — ما لا يقوله في وثيقة وداع لا مكان له في الكتاب.
- **المحلية أولًا.** الجمع والفهرسة والتركيب والتوليد كلها تعمل على جهازك. الاتصالات الشبكية الوحيدة هي إلى واجهة GitHub البرمجية وإلى مزوّد الـLLM الذي ضبطته. اختر **Ollama** فلن يصل بايت واحد من محتوى المستودع إلى أي طرف ثالث.
- **الفهرس مادة حساسة.** يحتوي `handover-data/*.db` على تاريخ الـcommits الكامل لفريقك. وهو مستثنى من Git افتراضيًا (gitignored)؛ تعامل مع الملف كما تتعامل مع بيانات اعتماد (credential).
- **الهلوسة خطأ برمجي، لا صفة عارضة.** يجب أن يستشهد ناتج الـLLM بمراجع الأدلة؛ ويجب وسم الادعاءات غير المسنودة بـ*(inference)*. لا تثق بأي فصل لم تتحقق منه عشوائيًا مقابل سلسلة أدلته.
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
- [ ] تشغيل `npx handover-book gen` من طرف إلى طرف على مستودع عام حقيقي (النسخة الأولية MVP، الأسابيع 1–3)
- [ ] إخراج PDF / HTML وعرض تقليب الصفحات
- [ ] مسار الثلاثين يومًا + رسالة إلى المستقبل مع صقل نقل الأسلوب عبر الـLLM (v0.2)
- [ ] قارئ ويب محلي بروابط أدلة معمّقة (v0.2)
- [ ] خريطة مخاطر القدرات على مستوى المؤسسة (v1.0)

## التسمية

حزمة npm هي `handover-book` (فالاسم `handover` مشغول بحزمة مُهمَلة)؛ أما أمر الواجهة فهو `handover`. اسم المنتج النهائي ما يزال مفتوحًا — انظر §8.1 من خطة المشروع.

## الترخيص

[MIT](LICENSE)
