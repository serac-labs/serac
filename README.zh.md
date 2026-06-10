<p align="center">
  <a href="https://serac.build">
    <h1 align="center">Serac</h1>
  </a>
</p>
<p align="center">开源的 AI Coding Agent。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@serac-labs/serac"><img alt="npm" src="https://img.shields.io/npm/v/@serac-labs/serac?style=flat-square" /></a>
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

### 安装

```bash
# 直接安装 (YOLO)
curl -fsSL https://serac.build/install | bash

# 软件包管理器
npm i -g @serac-labs/serac@latest  # 也可使用 bun/pnpm/yarn
```

> [!TIP]
> 安装前请先移除 0.1.x 之前的旧版本。

### 桌面应用程序 (BETA)

Serac 也提供桌面版应用。可直接从 [发布页 (releases page)](https://github.com/serac-labs/serac/releases) 或 [github.com/serac-labs/serac/releases/latest](https://github.com/serac-labs/serac/releases/latest) 下载。

| 平台                  | 下载文件                        |
| --------------------- | ------------------------------- |
| macOS (Apple Silicon) | `serac-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `serac-desktop-mac-x64.dmg`     |
| Windows               | `serac-desktop-windows-x64.exe` |
| Linux                 | `.deb`、`.rpm` 或 AppImage      |

```bash
# macOS (Homebrew Cask)
brew install --cask serac-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/serac-desktop
```

#### 安装目录

安装脚本按照以下优先级决定安装路径：

1. `$SERAC_INSTALL_DIR` - 自定义安装目录
2. `$XDG_BIN_DIR` - 符合 XDG 基础目录规范的路径
3. `$HOME/bin` - 如果存在或可创建的用户二进制目录
4. `$HOME/.opencode/bin` - 默认备用路径

```bash
# 示例
SERAC_INSTALL_DIR=/usr/local/bin curl -fsSL https://serac.build/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://serac.build/install | bash
```

### Agents

Serac 内置两种 Agent，可用 `Tab` 键快速切换：

- **build** - 默认模式，具备完整权限，适合开发工作
- **plan** - 只读模式，适合代码分析与探索
  - 默认拒绝修改文件
  - 运行 bash 命令前会询问
  - 便于探索未知代码库或规划改动

另外还包含一个 **general** 子 Agent，用于复杂搜索和多步任务，内部使用，也可在消息中输入 `@general` 调用。

了解更多 [Agents](https://serac.build/docs/agents) 相关信息。

### 文档

更多配置说明请查看我们的 [**官方文档**](https://serac.build/docs)。

### 参与贡献

如有兴趣贡献代码，请在提交 PR 前阅读 [贡献指南 (Contributing Docs)](./CONTRIBUTING.md)。

### 基于 Serac 进行开发

如果你在项目名中使用了 “serac”（如 “serac-dashboard” 或 “serac-mobile”），请在 README 里注明该项目不是 Serac 团队官方开发，且不存在隶属关系。
