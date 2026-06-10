<p align="center">
  <a href="https://serac.build">
    <picture>
      <img src="https://img.shields.io/badge/Serac-000000?style=for-the-badge" alt="Serac logo">
    </picture>
  </a>
</p>
<p align="center">Открытый AI-агент для программирования.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/core"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/core?style=flat-square" /></a>
  <a href="https://github.com/serac-labs/serac/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/serac-labs/serac/publish.yml?style=flat-square&branch=dev" /></a>
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

### Установка

```bash
# YOLO
curl -fsSL https://serac.build/install | bash

# Менеджеры пакетов
npm i -g @serac-labs/core@latest  # или bun/pnpm/yarn
```

> [!TIP]
> Перед установкой удалите версии старше 0.1.x.

### Десктопное приложение (BETA)

Serac также доступен как десктопное приложение. Скачайте его со [страницы релизов](https://github.com/serac-labs/serac/releases) или с [github.com/serac-labs/serac/releases/latest](https://github.com/serac-labs/serac/releases/latest).

| Платформа             | Загрузка                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `serac-desktop-mac-arm64.dmg`      |
| macOS (Intel)         | `serac-desktop-mac-x64.dmg`        |
| Windows               | `serac-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` или AppImage        |

```bash
# macOS (Homebrew)
brew install --cask serac-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/serac-desktop
```

#### Каталог установки

Скрипт установки выбирает путь установки в следующем порядке приоритета:

1. `$SERAC_INSTALL_DIR` - Пользовательский каталог установки
2. `$XDG_BIN_DIR` - Путь, совместимый со спецификацией XDG Base Directory
3. `$HOME/bin` - Стандартный каталог пользовательских бинарников (если существует или можно создать)
4. `$HOME/.serac/bin` - Fallback по умолчанию

```bash
# Примеры
SERAC_INSTALL_DIR=/usr/local/bin curl -fsSL https://serac.build/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://serac.build/install | bash
```

### Agents

В Serac есть два встроенных агента, между которыми можно переключаться клавишей `Tab`.

- **build** - По умолчанию, агент с полным доступом для разработки
- **plan** - Агент только для чтения для анализа и изучения кода
  - По умолчанию запрещает редактирование файлов
  - Запрашивает разрешение перед выполнением bash-команд
  - Идеален для изучения незнакомых кодовых баз или планирования изменений

Также включен сабагент **general** для сложных поисков и многошаговых задач.
Он используется внутренне и может быть вызван в сообщениях через `@general`.

Подробнее об [agents](https://serac.build/docs/agents).

### Документация

Больше информации о том, как настроить Serac: [**наши docs**](https://serac.build/docs).

### Вклад

Если вы хотите внести вклад в Serac, прочитайте [contributing docs](./CONTRIBUTING.md) перед тем, как отправлять pull request.

### Разработка на базе Serac

Если вы делаете проект, связанный с Serac, и используете "serac" как часть имени (например, "serac-dashboard" или "serac-mobile"), добавьте примечание в README, чтобы уточнить, что проект не создан командой Serac и не аффилирован с нами.

---

**Присоединяйтесь к нашему сообществу** [Discord](https://serac.build) | [X.com](https://serac.build)
