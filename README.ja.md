<p align="center">
  <a href="https://serac.build">
    <picture>
      <img src="https://img.shields.io/badge/Serac-000000?style=for-the-badge&logoColor=white" alt="Serac logo">
    </picture>
  </a>
</p>
<p align="center">オープンソースのAIコーディングエージェント。</p>
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

### インストール

```bash
# YOLO
curl -fsSL https://serac.build/install | bash

# パッケージマネージャー
npm i -g @serac-labs/serac@latest  # bun/pnpm/yarn でもOK
scoop install serac                # Windows
choco install serac                # Windows
brew install serac-labs/tap/serac  # macOS と Linux（推奨。常に最新）
brew install serac                 # macOS と Linux（公式 brew formula。更新頻度は低め）
sudo pacman -S serac               # Arch Linux (Stable)
paru -S serac-bin                  # Arch Linux (Latest from AUR)
mise use -g serac                  # どのOSでも
nix run nixpkgs#serac              # または github:serac-labs/serac で最新 dev ブランチ
```

> [!TIP]
> インストール前に 0.1.x より古いバージョンを削除してください。

### デスクトップアプリ (BETA)

Serac はデスクトップアプリとしても利用できます。[releases page](https://github.com/serac-labs/serac/releases) から直接ダウンロードするか、[github.com/serac-labs/serac/releases/latest](https://github.com/serac-labs/serac/releases/latest) を利用してください。

| プラットフォーム      | ダウンロード                       |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `serac-desktop-mac-arm64.dmg`      |
| macOS (Intel)         | `serac-desktop-mac-x64.dmg`        |
| Windows               | `serac-desktop-windows-x64.exe`    |
| Linux                 | `.deb`、`.rpm`、または AppImage    |

```bash
# macOS (Homebrew)
brew install --cask serac-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/serac-desktop
```

#### インストールディレクトリ

インストールスクリプトは、インストール先パスを次の優先順位で決定します。

1. `$SERAC_INSTALL_DIR` - カスタムのインストールディレクトリ
2. `$XDG_BIN_DIR` - XDG Base Directory Specification に準拠したパス
3. `$HOME/bin` - 標準のユーザー用バイナリディレクトリ（存在する場合、または作成できる場合）
4. `$HOME/.opencode/bin` - デフォルトのフォールバック

```bash
# 例
SERAC_INSTALL_DIR=/usr/local/bin curl -fsSL https://serac.build/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://serac.build/install | bash
```

### Agents

Serac には組み込みの Agent が2つあり、`Tab` キーで切り替えられます。

- **build** - デフォルト。開発向けのフルアクセス Agent
- **plan** - 分析とコード探索向けの読み取り専用 Agent
  - デフォルトでファイル編集を拒否
  - bash コマンド実行前に確認
  - 未知のコードベース探索や変更計画に最適

また、複雑な検索やマルチステップのタスク向けに **general** サブ Agent も含まれています。
内部的に使用されており、メッセージで `@general` と入力して呼び出せます。

[agents](https://serac.build/docs/agents) の詳細はこちら。

### ドキュメント

Serac の設定については [**ドキュメント**](https://serac.build/docs) を参照してください。

### コントリビュート

Serac に貢献したい場合は、Pull Request を送る前に [contributing docs](./CONTRIBUTING.md) を読んでください。

### Serac の上に構築する

Serac に関連するプロジェクトで、名前に "serac"（例: "serac-dashboard" や "serac-mobile"）を含める場合は、そのプロジェクトが Serac チームによって作られたものではなく、いかなる形でも関係がないことを README に明記してください。

---

**コミュニティに参加** [Discord](https://serac.build) | [X.com](https://serac.build)
