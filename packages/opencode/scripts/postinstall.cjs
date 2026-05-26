#!/usr/bin/env node
const https = require("https")
const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")
const { execSync } = require("child_process")

const pkg = require("../package.json")
const VERSION = pkg.version
const REPO = "serac-labs/serac"

// Expected SHA-256 of each platform tarball, generated at publish time and
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
const archMap = { x64: "x64", arm64: "arm64" }

const platform = platformMap[os.platform()] || os.platform()
let arch = archMap[os.arch()] || os.arch()

// Windows 11 on ARM64 runs x64 binaries via the built-in emulator. We don't
// ship a native windows-arm64 build, so download the x64 tarball instead.
const nativeArch = arch
if (platform === "windows" && arch === "arm64") {
  arch = "x64"
}

const tarballName = "serac-" + platform + "-" + arch + ".tar.gz"

const pkgDir = path.join(__dirname, "..")
const binaryName = platform === "windows" ? "serac.exe" : "serac"
const binaryPath = path.join(pkgDir, "bin", binaryName)

// Verify the binary matches the current platform by checking magic bytes
function binaryMatchesPlatform(filePath) {
  try {
    var fd = fs.openSync(filePath, "r")
    var buf = Buffer.alloc(4)
    fs.readSync(fd, buf, 0, 4, 0)
    fs.closeSync(fd)
    var magic = buf.toString("hex")

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

// Check if file exists AND is a real binary (not just a launcher script)
// Launcher scripts are small (~2KB), actual binaries are 20MB+
// Also verify the binary is for the current platform (not a leftover from CI)
if (fs.existsSync(binaryPath)) {
  var stats = fs.statSync(binaryPath)
  if (stats.size > 100000 && binaryMatchesPlatform(binaryPath)) {
    console.log("serac: binary already exists")
    process.exit(0)
  }
  if (stats.size > 100000) {
    console.log("serac: existing binary is for the wrong platform, re-downloading...")
  }
}

const releaseUrl = "https://github.com/" + REPO + "/releases/download/v" + VERSION + "/" + tarballName
const archLabel = nativeArch === arch ? platform + "-" + arch : platform + "-" + nativeArch + " (via " + arch + " emulation)"
console.log("serac: downloading binary for " + archLabel + "...")

function followRedirects(url, callback) {
  https.get(url, { headers: { "User-Agent": "serac" } }, function (res) {
    if (res.statusCode === 302 || res.statusCode === 301) {
      followRedirects(res.headers.location, callback)
    } else {
      callback(res)
    }
  })
}

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "serac-"))
var tarPath = path.join(tmpDir, tarballName)
var file = fs.createWriteStream(tarPath)

followRedirects(releaseUrl, function (res) {
  if (res.statusCode !== 200) {
    console.warn("serac: could not download binary (HTTP " + res.statusCode + ")")
    console.warn("serac: download manually from https://github.com/" + REPO + "/releases")
    process.exit(0)
  }

  res.pipe(file)
  file.on("finish", function () {
    file.close()

    // Integrity gate: verify the downloaded tarball against the
    // provenance-covered checksum BEFORE extracting or executing anything.
    var expectedHash = EXPECTED_CHECKSUMS[tarballName]
    if (expectedHash) {
      var actualHash = sha256(tarPath)
      if (actualHash !== expectedHash) {
        console.error("serac: SECURITY: checksum mismatch for " + tarballName)
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
      console.warn("serac: no published checksum for " + tarballName + " — skipping integrity check")
    }

    try {
      execSync('tar -xzf "' + tarPath + '" -C "' + pkgDir + '"', { stdio: "pipe" })
      if (platform !== "windows" && fs.existsSync(binaryPath)) {
        fs.chmodSync(binaryPath, 493)
      }
      console.log("serac: binary installed")
    } catch (e) {
      console.warn("serac: could not extract binary")
    }
    try {
      fs.rmSync(tmpDir, { recursive: true })
    } catch (e) {}
  })
})
