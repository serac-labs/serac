<p align="center">
  <a href="https://serac.build">
    <picture>
      <img alt="Serac" src="https://img.shields.io/badge/Serac-000000?style=for-the-badge&logoColor=white">
    </picture>
  </a>
</p>
<p align="center">وكيل برمجة بالذكاء الاصطناعي مفتوح المصدر.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/core"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/core?style=flat-square" /></a>
  <a href="https://github.com/serac-labs/serac/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/serac-labs/serac/publish.yml?style=flat-square&branch=main" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>


---

### التثبيت

```bash
# YOLO
curl -fsSL https://serac.build/install | bash

# مديري الحزم
npm i -g @serac-labs/core@latest  # او bun/pnpm/yarn
```

> [!TIP]
> احذف الاصدارات الاقدم من 0.1.x قبل التثبيت.

### تطبيق سطح المكتب (BETA)

يتوفر Serac ايضا كتطبيق سطح مكتب. قم بالتنزيل مباشرة من [صفحة الاصدارات](https://github.com/serac-labs/serac/releases) او من [github.com/serac-labs/serac/releases/latest](https://github.com/serac-labs/serac/releases/latest).

| المنصة                | التنزيل                            |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `serac-desktop-mac-arm64.dmg`      |
| macOS (Intel)         | `serac-desktop-mac-x64.dmg`        |
| Windows               | `serac-desktop-windows-x64.exe`    |
| Linux                 | `.deb` او `.rpm` او AppImage       |

#### مجلد التثبيت

يحترم سكربت التثبيت ترتيب الاولوية التالي لمسار التثبيت:

1. `$SERAC_INSTALL_DIR` - مجلد تثبيت مخصص
2. `$XDG_BIN_DIR` - مسار متوافق مع مواصفات XDG Base Directory
3. `$HOME/bin` - مجلد الثنائيات القياسي للمستخدم (ان وجد او امكن انشاؤه)
4. `$HOME/.opencode/bin` - المسار الافتراضي الاحتياطي

```bash
# امثلة
SERAC_INSTALL_DIR=/usr/local/bin curl -fsSL https://serac.build/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://serac.build/install | bash
```

### Agents

يتضمن Serac وكيليْن (Agents) مدمجين يمكنك التبديل بينهما باستخدام زر `Tab`.

- **build** - الافتراضي، وكيل بصلاحيات كاملة لاعمال التطوير
- **plan** - وكيل للقراءة فقط للتحليل واستكشاف الكود
  - يرفض تعديل الملفات افتراضيا
  - يطلب الاذن قبل تشغيل اوامر bash
  - مثالي لاستكشاف قواعد كود غير مألوفة او لتخطيط التغييرات

بالاضافة الى ذلك يوجد وكيل فرعي **general** للبحث المعقد والمهام متعددة الخطوات.
يستخدم داخليا ويمكن استدعاؤه بكتابة `@general` في الرسائل.

تعرف على المزيد حول [agents](https://serac.build/docs/agents).

### التوثيق

لمزيد من المعلومات حول كيفية ضبط Serac، [**راجع التوثيق**](https://serac.build/docs).

### المساهمة

اذا كنت مهتما بالمساهمة في Serac، يرجى قراءة [contributing docs](./CONTRIBUTING.md) قبل ارسال pull request.

### البناء فوق Serac

اذا كنت تعمل على مشروع مرتبط بـ Serac ويستخدم "serac" كجزء من اسمه (مثل "serac-dashboard" او "serac-mobile")، يرجى اضافة ملاحظة في README توضح انه ليس مبنيا بواسطة فريق Serac ولا يرتبط بنا بأي شكل.

---

**انضم الى مجتمعنا** [GitHub](https://github.com/serac-labs/serac) | [serac.build](https://serac.build)
