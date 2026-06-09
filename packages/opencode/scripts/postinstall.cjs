#!/usr/bin/env node

// Approach B: ONE published npm package (@serac-labs/core) that ships the
// LAUNCHER script (bin/opencode) plus this postinstall. At install time we
// download the matching prebuilt platform binary from the GitHub Release for
// this exact version, verify it against the provenance-covered checksums.json
// shipped inside the package, extract it next to the launcher, and let the
// launcher exec it.
//
// Naming chain (must stay in lock-step):
//   build.ts        -> dist/serac-core-<suffix>/bin/opencode  +  serac-core-<suffix>.tar.gz (linux) / .zip (darwin,windows)
//   publish-npm.yml -> uploads those same serac-core-<suffix>.{tar.gz,zip} to the GH release + writes checksums.json over them
//   THIS FILE       -> downloads serac-core-<suffix>.{tar.gz,zip}, verifies against checksums.json, extracts
//   bin/opencode    -> execs the extracted binary at bin/.opencode (its existing `cached` hook)

const https = require("https")
const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")
const { execSync, spawnSync } = require("child_process")

const pkg = require("../package.json")
const VERSION = pkg.version
const REPO = "serac-labs/serac"

// Expected SHA-256 of every platform archive, generated at publish time and
// shipped INSIDE this package, so npm's provenance/attestation covers it.
// The binary itself is downloaded separately from GitHub Releases (below),
// which provenance does NOT cover — so we verify it against this before
// trusting it, closing that supply-chain gap. A missing file/entry skips
// verification (graceful for older/local builds); a tampered package that
// stripped this file would fail `npm audit signatures`.
let EXPECTED_CHECKSUMS = {}
try {
  EXPECTED_CHECKSUMS = require("../checksums.json")
} catch (e) {
  /* no checksums shipped (older package or local build) — skip verification */
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")
}

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" }
const archMap = { x64: "x64", arm64: "arm64", arm: "arm" }

const platform = platformMap[os.platform()] || os.platform()
let arch = archMap[os.arch()] || os.arch()

// Windows 11 on ARM64 runs x64 binaries via the built-in emulator. We don't
// ship a native windows-arm64 build, so download the x64 archive instead.
const nativeArch = arch
if (platform === "windows" && arch === "arm64") {
  arch = "x64"
}

// build.ts emits ".tar.gz" for linux targets and ".zip" for darwin/windows.
const ext = platform === "linux" ? "tar.gz" : "zip"

// Mirror bin/opencode's detection so we pick the SAME archive the launcher
// would resolve from node_modules: avx2/baseline (x64) + musl (linux).
function supportsAvx2() {
  if (arch !== "x64") return false
  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }
  if (platform === "darwin") {
    try {
      const result = spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], { encoding: "utf8", timeout: 1500 })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }
  if (platform === "windows") {
    const cmd =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'
    for (const exe of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const out = (result.stdout || "").trim().toLowerCase()
        if (out === "true" || out === "1") return true
        if (out === "false" || out === "0") return false
      } catch {
        continue
      }
    }
    return false
  }
  return false
}

function isMusl() {
  if (platform !== "linux") return false
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    /* ignore */
  }
  try {
    const result = spawnSync("ldd", ["--version"], { encoding: "utf8" })
    const text = ((result.stdout || "") + (result.stderr || "")).toLowerCase()
    if (text.includes("musl")) return true
  } catch {
    /* ignore */
  }
  return false
}

// Ordered list of candidate slugs (best match first), matching the suffixes
// build.ts emits: <os>-<arch>[-baseline][-musl]. "windows" is used in the
// slug (build.ts rewrites win32 -> windows).
const candidateSlugs = (() => {
  const base = "serac-core-" + platform + "-" + arch
  const baseline = arch === "x64" && !supportsAvx2()
  const musl = isMusl()

  if (platform === "linux") {
    if (musl) {
      if (arch === "x64") {
        if (baseline) return [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
        return [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
      }
      return [`${base}-musl`, base]
    }
    if (arch === "x64") {
      if (baseline) return [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
      return [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
    }
    return [base, `${base}-musl`]
  }

  if (arch === "x64") {
    if (baseline) return [`${base}-baseline`, base]
    return [base, `${base}-baseline`]
  }
  return [base]
})()

const pkgDir = path.join(__dirname, "..")
const binDir = path.join(pkgDir, "bin")
// Bun's `--compile --target bun-windows-*` AUTO-APPENDS ".exe", so the windows
// dist dirs (and therefore the windows .zip) contain `opencode.exe`, while
// linux/darwin archives contain a plain `opencode`. Mirror that here.
const extractedName = platform === "windows" ? "opencode.exe" : "opencode"
// The launcher (bin/opencode) execs this path first via its `cached` hook.
// On windows it must be a real .exe so Windows can exec it directly.
const binaryName = platform === "windows" ? ".opencode.exe" : ".opencode"
const binaryPath = path.join(binDir, binaryName)

// Verify a candidate binary's magic bytes match the current platform, so a
// leftover/wrong-platform binary doesn't get trusted.
function binaryMatchesPlatform(filePath) {
  try {
    const fd = fs.openSync(filePath, "r")
    const buf = Buffer.alloc(4)
    fs.readSync(fd, buf, 0, 4, 0)
    fs.closeSync(fd)
    const magic = buf.toString("hex")
    if (platform === "darwin") {
      // Mach-O: cffaedfe (64-bit LE), feedfacf (64-bit BE), cafebabe (universal/fat)
      return magic === "cffaedfe" || magic === "feedfacf" || magic === "cafebabe"
    }
    if (platform === "linux") {
      // ELF: 7f454c46
      return magic === "7f454c46"
    }
    if (platform === "windows") {
      // PE/MZ: 4d5a
      return magic.startsWith("4d5a")
    }
    return false
  } catch (e) {
    return false
  }
}

// Skip if a real, current-platform binary is already in place. Launcher
// scripts are tiny (~5KB); the compiled binary is tens of MB.
if (fs.existsSync(binaryPath)) {
  const stats = fs.statSync(binaryPath)
  if (stats.size > 100000 && binaryMatchesPlatform(binaryPath)) {
    console.log("serac: binary already exists")
    process.exit(0)
  }
}

function followRedirects(url, callback) {
  https.get(url, { headers: { "User-Agent": "serac" } }, function (res) {
    if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
      followRedirects(res.headers.location, callback)
    } else {
      callback(res)
    }
  })
}

function download(url) {
  return new Promise((resolve) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serac-"))
    const archiveName = path.basename(new URL(url).pathname)
    const archivePath = path.join(tmpDir, archiveName)
    const file = fs.createWriteStream(archivePath)
    followRedirects(url, function (res) {
      if (res.statusCode !== 200) {
        file.close()
        try {
          fs.rmSync(tmpDir, { recursive: true })
        } catch (e) {}
        resolve({ ok: false, status: res.statusCode })
        return
      }
      res.pipe(file)
      file.on("finish", function () {
        file.close(() => resolve({ ok: true, tmpDir, archivePath, archiveName }))
      })
    })
  })
}

function extract(archivePath, ext, destDir) {
  if (ext === "tar.gz") {
    // build.ts tars the CONTENTS of bin/ flat, so `opencode` lands directly in destDir.
    execSync('tar -xzf "' + archivePath + '" -C "' + destDir + '"', { stdio: "pipe" })
    return path.join(destDir, extractedName)
  }
  // .zip — also flat contents of bin/. Prefer system unzip; fall back to
  // PowerShell Expand-Archive on Windows runners without unzip. On windows the
  // archived file is `opencode.exe` (Bun's auto-appended .exe), elsewhere `opencode`.
  try {
    execSync('unzip -o "' + archivePath + '" -d "' + destDir + '"', { stdio: "pipe" })
  } catch (e) {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`,
      ],
      { stdio: "pipe" },
    )
  }
  return path.join(destDir, extractedName)
}

async function main() {
  // Pick the first candidate slug that the published checksums know about; if
  // checksums are absent (local build), just use the best candidate.
  const known = candidateSlugs.find((slug) => EXPECTED_CHECKSUMS[`${slug}.${ext}`])
  const slug = known || candidateSlugs[0]
  const archiveName = `${slug}.${ext}`
  const releaseUrl = "https://github.com/" + REPO + "/releases/download/v" + VERSION + "/" + archiveName

  const archLabel =
    nativeArch === arch ? platform + "-" + arch : platform + "-" + nativeArch + " (via " + arch + " emulation)"
  console.log("serac: downloading binary for " + archLabel + " (" + slug + ")...")

  const result = await download(releaseUrl)
  if (!result.ok) {
    console.warn("serac: could not download binary (HTTP " + result.status + ")")
    console.warn("serac: download manually from https://github.com/" + REPO + "/releases")
    process.exit(0)
  }

  const { tmpDir, archivePath } = result

  // Integrity gate: verify the downloaded archive against the
  // provenance-covered checksum BEFORE extracting or executing anything.
  const expectedHash = EXPECTED_CHECKSUMS[archiveName]
  if (expectedHash) {
    const actualHash = sha256(archivePath)
    if (actualHash !== expectedHash) {
      console.error("serac: SECURITY: checksum mismatch for " + archiveName)
      console.error("serac:   expected " + expectedHash)
      console.error("serac:   actual   " + actualHash)
      console.error("serac: refusing to install a tampered binary — aborting.")
      try {
        fs.rmSync(tmpDir, { recursive: true })
      } catch (e) {}
      process.exit(1)
    }
    console.log("serac: binary checksum verified")
  } else {
    console.warn("serac: no published checksum for " + archiveName + " — skipping integrity check")
  }

  try {
    fs.mkdirSync(binDir, { recursive: true })
    const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "serac-x-"))
    const extracted = extract(archivePath, ext, extractedDir)
    if (!fs.existsSync(extracted)) {
      console.warn("serac: archive did not contain the expected binary")
      process.exit(0)
    }
    fs.copyFileSync(extracted, binaryPath)
    if (platform !== "windows") fs.chmodSync(binaryPath, 0o755)
    try {
      fs.rmSync(extractedDir, { recursive: true })
    } catch (e) {}
    console.log("serac: binary installed")
  } catch (e) {
    console.warn("serac: could not extract binary: " + (e && e.message ? e.message : e))
  }
  try {
    fs.rmSync(tmpDir, { recursive: true })
  } catch (e) {}
}

main()
