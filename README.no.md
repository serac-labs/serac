<p align="center">
  <a href="https://serac.build">
    <h1 align="center">Serac</h1>
  </a>
</p>
<p align="center">AI-kodeagent med åpen kildekode.</p>
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

### Installasjon

```bash
# YOLO
curl -fsSL https://serac.build/install | bash

# Pakkehåndterere
npm i -g @serac-labs/serac@latest  # eller bun/pnpm/yarn
```

> [!TIP]
> Fjern versjoner eldre enn 0.1.x før du installerer.

### Desktop-app (BETA)

Serac er også tilgjengelig som en desktop-app. Last ned direkte fra [releases-siden](https://github.com/serac-labs/serac/releases) eller [github.com/serac-labs/serac/releases/latest](https://github.com/serac-labs/serac/releases/latest).

| Plattform             | Nedlasting                         |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `serac-desktop-mac-arm64.dmg`      |
| macOS (Intel)         | `serac-desktop-mac-x64.dmg`        |
| Windows               | `serac-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm` eller AppImage      |

#### Installasjonsmappe

Installasjonsskriptet bruker følgende prioritet for installasjonsstien:

1. `$SERAC_INSTALL_DIR` - Egendefinert installasjonsmappe
2. `$XDG_BIN_DIR` - Sti som følger XDG Base Directory Specification
3. `$HOME/bin` - Standard brukerbinar-mappe (hvis den finnes eller kan opprettes)
4. `$HOME/.opencode/bin` - Standard fallback

```bash
# Eksempler
SERAC_INSTALL_DIR=/usr/local/bin curl -fsSL https://serac.build/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://serac.build/install | bash
```

### Agents

Serac har to innebygde agents du kan bytte mellom med `Tab`-tasten.

- **build** - Standard, agent med full tilgang for utviklingsarbeid
- **plan** - Skrivebeskyttet agent for analyse og kodeutforsking
  - Nekter filendringer som standard
  - Spør om tillatelse før bash-kommandoer
  - Ideell for å utforske ukjente kodebaser eller planlegge endringer

Det finnes også en **general**-subagent for komplekse søk og flertrinnsoppgaver.
Den brukes internt og kan kalles via `@general` i meldinger.

Les mer om [agents](https://serac.build/docs/agents).

### Dokumentasjon

For mer info om hvordan du konfigurerer Serac, [**se dokumentasjonen**](https://serac.build/docs).

### Bidra

Hvis du vil bidra til Serac, les [contributing docs](./CONTRIBUTING.md) før du sender en pull request.

### Bygge på Serac

Hvis du jobber med et prosjekt som er relatert til Serac og bruker "serac" som en del av navnet; for eksempel "serac-dashboard" eller "serac-mobile", legg inn en merknad i README som presiserer at det ikke er bygget av Serac-teamet og ikke er tilknyttet oss på noen måte.

---

**Bli med i fellesskapet** [GitHub](https://github.com/serac-labs/serac) | [serac.build](https://serac.build)
