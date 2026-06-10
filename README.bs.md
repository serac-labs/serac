<p align="center">
  <a href="https://serac.build">
    <picture>
      <img src="https://img.shields.io/badge/Serac-000000?style=for-the-badge&logo=&logoColor=white" alt="Serac">
    </picture>
  </a>
</p>
<p align="center">Serac je open source AI agent za programiranje.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/core"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/core?style=flat-square" /></a>
  <a href="https://github.com/serac-labs/serac"><img alt="GitHub" src="https://img.shields.io/github/stars/serac-labs/serac?style=flat-square" /></a>
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

### Instalacija

```bash
# YOLO
curl -fsSL https://serac.build/install | bash

# Package manageri
npm i -g @serac-labs/core@latest  # ili bun/pnpm/yarn
```

> [!TIP]
> Ukloni verzije starije od 0.1.x prije instalacije.

### Desktop aplikacija (BETA)

Serac je dostupan i kao desktop aplikacija. Preuzmi je direktno sa [stranice izdanja](https://github.com/serac-labs/serac/releases) ili sa [github.com/serac-labs/serac/releases/latest](https://github.com/serac-labs/serac/releases/latest).

| Platforma             | Preuzimanje                     |
| --------------------- | ------------------------------- |
| macOS (Apple Silicon) | `serac-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `serac-desktop-mac-x64.dmg`     |
| Windows               | `serac-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, ili AppImage    |

```bash
# macOS (Homebrew)
brew install --cask serac-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/serac-desktop
```

#### Instalacijski direktorij

Instalacijska skripta koristi sljedeći redoslijed prioriteta za putanju instalacije:

1. `$SERAC_INSTALL_DIR` - Prilagođeni instalacijski direktorij
2. `$XDG_BIN_DIR` - Putanja usklađena sa XDG Base Directory specifikacijom
3. `$HOME/bin` - Standardni korisnički bin direktorij (ako postoji ili se može kreirati)
4. `$HOME/.opencode/bin` - Podrazumijevana rezervna lokacija

```bash
# Primjeri
SERAC_INSTALL_DIR=/usr/local/bin curl -fsSL https://serac.build/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://serac.build/install | bash
```

### Agenti

Serac uključuje dva ugrađena agenta između kojih možeš prebacivati tasterom `Tab`.

- **build** - Podrazumijevani agent sa punim pristupom za razvoj
- **plan** - Agent samo za čitanje za analizu i istraživanje koda
  - Podrazumijevano zabranjuje izmjene datoteka
  - Traži dozvolu prije pokretanja bash komandi
  - Idealan za istraživanje nepoznatih codebase-ova ili planiranje izmjena

Uključen je i **general** pod-agent za složene pretrage i višekoračne zadatke.
Koristi se interno i može se pozvati pomoću `@general` u porukama.

Saznaj više o [agentima](https://serac.build/docs/agents).

### Dokumentacija

Za više informacija o konfiguraciji Serac-a, [**pogledaj dokumentaciju**](https://serac.build/docs).

### Doprinosi

Ako želiš doprinositi Serac-u, pročitaj [upute za doprinošenje](./CONTRIBUTING.md) prije slanja pull requesta.

### Gradnja na Serac-u

Ako radiš na projektu koji je povezan sa Serac-om i koristi "serac" kao dio naziva, npr. "serac-dashboard" ili "serac-mobile", dodaj napomenu u svoj README da projekat nije napravio Serac tim i da nije povezan s nama.

---

**Pridruži se našoj zajednici** [Discord](https://serac.build) | [X.com](https://serac.build)
