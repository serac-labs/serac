<p align="center">
  <a href="https://serac.build">
    <h1 align="center">Serac</h1>
  </a>
</p>
<p align="center">Den open source AI-kodeagent.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/serac"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/serac?style=flat-square" /></a>
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

[![Serac Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://serac.build)

---

### Installation

```bash
# YOLO
curl -fsSL https://serac.build/install | bash

# Pakkehåndteringer
npm i -g @serac-labs/serac@latest        # eller bun/pnpm/yarn
```

> [!TIP]
> Fjern versioner ældre end 0.1.x før installation.

### Desktop-app (BETA)

Serac findes også som desktop-app. Download direkte fra [releases-siden](https://github.com/serac-labs/serac/releases) eller [github.com/serac-labs/serac/releases/latest](https://github.com/serac-labs/serac/releases/latest).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `serac-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `serac-desktop-mac-x64.dmg`     |
| Windows               | `serac-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, eller AppImage     |

#### Installationsmappe

Installationsscriptet bruger følgende prioriteringsrækkefølge for installationsstien:

1. `$SERAC_INSTALL_DIR` - Tilpasset installationsmappe
2. `$XDG_BIN_DIR` - Sti der følger XDG Base Directory Specification
3. `$HOME/bin` - Standard bruger-bin-mappe (hvis den findes eller kan oprettes)
4. `$HOME/.opencode/bin` - Standard fallback

```bash
# Eksempler
SERAC_INSTALL_DIR=/usr/local/bin curl -fsSL https://serac.build/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://serac.build/install | bash
```

### Agents

Serac har to indbyggede agents, som du kan skifte mellem med `Tab`-tasten.

- **build** - Standard, agent med fuld adgang til udviklingsarbejde
- **plan** - Skrivebeskyttet agent til analyse og kodeudforskning
  - Afviser filredigering som standard
  - Spørger om tilladelse før bash-kommandoer
  - Ideel til at udforske ukendte kodebaser eller planlægge ændringer

Derudover findes der en **general**-subagent til komplekse søgninger og flertrinsopgaver.
Den bruges internt og kan kaldes via `@general` i beskeder.

Læs mere om [agents](https://serac.build/docs/agents).

### Dokumentation

For mere info om konfiguration af Serac, [**se vores docs**](https://serac.build/docs).

### Bidrag

Hvis du vil bidrage til Serac, så læs vores [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygget på Serac

Hvis du arbejder på et projekt der er relateret til Serac og bruger "serac" som en del af navnet; f.eks. "serac-dashboard" eller "serac-mobile", så tilføj en note i din README, der tydeliggør at projektet ikke er bygget af Serac-teamet og ikke er tilknyttet os på nogen måde.

Serac er en fork af [opencode](https://github.com/anomalyco/opencode) af SST.

---

**Bliv en del af vores community** [serac.build](https://serac.build)
