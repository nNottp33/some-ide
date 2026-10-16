# Spike: Code-OSS 1.141.0 build ได้พร้อม `product.json` overlay (ชื่อเรา + Open VSX)

**สรุปภาษาไทย (2026-10-16):** **ทำได้** — บนเครื่อง Linux 4 vCPU / 15 GB RAM, Code-OSS 1.141.0 clone, ติดตั้ง, compile (desktop + web) และรันได้
โดยชื่อ "Some IDE" และ gallery ของ Open VSX ไปถึง workbench ที่รันอยู่จริง (ดู screenshot) ใช้เวลารวม 39 นาที (เวลาเครื่องจริง ~15 นาทีถ้าเครือข่ายเปิด) ดิสก์ 8.9 GB

ตัวเลขสำคัญ: clone 8.6 s (402 MB) · `npm ci` + nested installs ~9 นาที, peak RAM ~3.2 GB · `npm run compile` 151 s, peak RAM ~9.9 GB (ผลรวมทั้ง process tree), `out/` 452 MB · `compile-web` 38 s · Electron 43.7.7 ดาวน์โหลด 316 MB และรัน workbench เต็มใต้ xvfb ได้

สิ่งที่ติดและแก้: ต้อง Node 24.18.0 ตาม `.nvmrc` (preinstall บังคับ) · ต้องมี `libkrb5-dev` และ `libxkbfile-dev` · เครื่องนี้ถูกบล็อก electronjs.org (headers), api.github.com (ripgrep prebuilt) และ open-vsx.org จึงต้องทำบางขั้นด้วยมือ — บน CI runner ที่เปิด egress ไม่ต้อง

**ผลที่กระทบแผน (ต้องรับรู้ก่อน P1):**
1. เมื่อตั้ง `extensionsGallery` แล้ว `build/lib/builtInExtensions.ts` จะดาวน์โหลด built-in extensions (js-debug ฯลฯ) จาก gallery นั้นแทน GitHub และ sha256 ที่ pin ไว้เป็นของ VSIX จาก GitHub → ต้องมี patch หรือ vendor VSIX เอง (อยู่ในรายการ patch ของแผนแล้ว: "builtin-ext source")
2. dev web workbench ไม่อ่าน `product.json` แต่ต้องใช้ `product.overrides.json` (web bundle ที่ build แล้วจะ inline product.json) · REH web server ส่ง `extensionsGallery` ต่อเมื่อมี `resourceUrlTemplate`
3. ความต้องการของ CI runner: Ubuntu 24.04 + gcc 13 + `libx11-dev libxkbfile-dev libkrb5-dev`, Node ตาม `.nvmrc`, ≥ 4 vCPU, 16 GB RAM, ≥ 20 GB disk, egress ไปยัง registry.npmjs.org, nodejs.org, electronjs.org (+artifacts), github.com release assets, api.github.com, raw.githubusercontent.com, api.nuget.org, open-vsx.org — รอบ dev เต็ม ~15 นาที

รายงานฉบับเต็มภาษาอังกฤษ (คำสั่งที่ใช้จริง, diff ของ product.json, blockers ทุกข้อ) อยู่ด้านล่าง

---

# P0 feasibility spike: Code-OSS 1.141.0 builds with a product.json overlay (own name + Open VSX gallery)

Date: 2026-10-16. Spike directory: `/tmp/claude-0/-home-user-some-ide/783122e1-78db-54a3-843d-e85e162815ce/scratchpad/vscode-spike/` (everything below is relative to it unless absolute). Total wall time from first command to last measurement: 39 min (05:16 to 05:56 UTC). The clone, `node_modules`, `out/`, `.build/` (Electron, remote Node, built-in extensions) and all logs are left on disk.

## Verdict

Feasible. Code-OSS 1.141.0 clones, installs, compiles (desktop + web dev build) and runs with a product.json overlay on a 4-vCPU / 15 GB Linux box in roughly 15 minutes of machine time, and the product name and Open VSX gallery reach the running workbench. The blockers hit were all environmental (missing system libraries, proxy-blocked hosts) or self-inflicted (a too-long `TMPDIR`), not caused by the overlay. Two upstream behaviours matter for the plan: (1) with a gallery configured, the build downloads the built-in extensions from that gallery instead of GitHub, and (2) the dev web workbench ignores product.json and needs `product.overrides.json` (a built web bundle inlines product.json).

## Environment

| Item | Value |
|---|---|
| OS / toolchain | Ubuntu 24.04.5 LTS, gcc 13.3.0, python 3.13.16, make, pkg-config, git |
| CPU / RAM / disk | 4 vCPU, 15 GB RAM, 29 GB free before the spike (19 GB after) |
| Node | 22.22.0 preinstalled (rejected by the repo); Node 24.18.0 installed locally from nodejs.org (31.5 MB tar.xz, bundles npm 11.16.0) |
| Repo pins | `.nvmrc` = 24.18.0; `package.json` has **no** `engines` field; `build/npm/preinstall.ts` (TypeScript, not `.js`) requires Node major 24 and >= 24.18.0, npm < 13, no yarn |
| Native headers | root `.npmrc`: Electron 43.7.7 headers from `https://electronjs.org/headers`; `remote/.npmrc`: Node 24.21.0 headers from `https://nodejs.org/dist`; `build/.npmrc`: Node 22.22.1 |
| Network (via proxy) | reachable: registry.npmjs.org, nodejs.org, github.com incl. release assets, raw.githubusercontent.com, api.nuget.org, archive.ubuntu.com. **Blocked (403 CONNECT):** electronjs.org, artifacts.electronjs.org, api.github.com, open-vsx.org, cdn.jsdelivr.net, pkgs.dev.azure.com |

## Measured numbers

| Step | Wall time | Peak RSS (process tree, sampled every 2 s; shared pages counted per process) | Result / size |
|---|---|---|---|
| `git clone --depth 1 --branch 1.141.0` | 8.6 s | n/a | 402 MB (65 MB `.git`), 19,972 files, commit `2a59476c` |
| `npm ci` attempt 1 | 128 s | 1,983 MiB | FAIL: `kerberos` -> `fatal error: gssapi/gssapi.h: No such file or directory` (libkrb5-dev missing); npm rolled `node_modules` back |
| `apt-get update && apt-get install -y --no-install-recommends libkrb5-dev libxkbfile-dev` | 11 s | n/a | worked (single attempt) |
| `npm ci` attempt 2 | 219 s | 3,215 MiB | FAIL: `@vscode/ripgrep` postinstall -> `GET https://api.github.com/repos/microsoft/ripgrep-prebuilt/releases/tags/v15.0.1` blocked; rolled back again |
| `npm ci` attempt 3 | 180 s | 3,147 MiB | dependency tree + all root native builds OK; root `preinstall` script failed: `node-gyp install --dist-url https://electronjs.org/headers 43.7.7` -> 403; `postinstall` (nested installs) therefore not run; `node_modules` kept (1.7 GB) |
| `node-gyp install --tarball node-v24.21.0-headers.tar.gz 43.7.7` (manual) | 6 s | n/a | substitutes Node 24.21.0 headers for the unreachable Electron headers |
| `npm_command=ci node build/npm/postinstall.ts` (manual) | 347 s | 2,089 MiB | 55 of 56 nested dirs installed (`electron.d.ts` fetched from GitHub releases); `extensions/copilot` postinstall failed with `listen EINVAL .../tmp/tsx-0/<pid>.pipe` (self-inflicted: my `TMPDIR` made the tsx IPC socket path exceed 108 bytes) |
| `npm run postinstall` in `extensions/copilot` with default TMPDIR | 4 s | 419 MiB | OK |
| `npm run compile` attempt 1 | 46 s | 4,691 MiB | FAIL: same tsx/TMPDIR issue inside `compile-copilot`; `npm-run-all2 -lp` then killed `compile-client`, no `out/` |
| `npm run compile` attempt 2 (TMPDIR override removed) | **151 s** | **9,934 MiB** | OK, exit 0, 160 gulp tasks finished; `out/` = **452 MB**; `extensions/copilot/dist` = 214 MB |
| `npm run compile-web` | **38 s** | 2,409 MiB | OK |
| `npm run electron` (Electron 43.7.7 from GitHub releases) | 13.4 s | n/a | 316 MB in `.build/electron`, binary renamed to `some-ide` per product.json |
| Web server start (`scripts/code-web.js`, first run downloads remote Node 24.21.0) | 6.7 s download, ready after ~16 s (~6 s on the second run) | n/a | `@vscode/test-web` 0.0.81 listening on :8080 |

Effective dependency-install time on a runner with open egress: about 180 s (root) + 347 s (nested dirs) = **~9 min**, peak **~3.2 GB**. Full dev cycle clone -> install -> compile -> compile-web -> Electron download: **~15 min** on 4 vCPU.

Disk used by the spike: **8.9 GB total** (the clone grows from 402 MB to 8.2 GB): root `node_modules` 1.7 GB, `extensions/copilot/node_modules` 1.6 GB, `remote/node_modules` 453 MB, `build/node_modules` 315 MB, `out/` 452 MB, `.build/` 444 MB (Electron 316 MB, remote Node 121 MB, built-in extensions 6 MB), node-gyp header cache 386 MB, local Node toolchain 203 MB. Host disk usage went from 11 GB to 21 GB.

## Exact commands that worked

```bash
SPIKE=/tmp/claude-0/-home-user-some-ide/783122e1-78db-54a3-843d-e85e162815ce/scratchpad/vscode-spike
cd $SPIKE
# 1. Node 24.18.0 (repo pin)
curl -sSL -o node-dl/node-v24.18.0-linux-x64.tar.xz https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz
tar -xJf node-dl/node-v24.18.0-linux-x64.tar.xz
source ./env.sh      # PATH=$SPIKE/node-v24.18.0-linux-x64/bin:$PATH, XDG_CACHE_HOME=$SPIKE/xdg-cache,
                     # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
# 2. clone
git clone --depth 1 --branch 1.141.0 https://github.com/microsoft/vscode.git
# 3. system libs (after the first npm ci failed on kerberos)
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libkrb5-dev libxkbfile-dev
# 3a. workarounds for proxy-blocked hosts (NOT needed on a runner with open egress):
#     - Electron headers: seed $XDG_CACHE_HOME/node-gyp/43.7.7 with Node 24.21.0 headers (node-gyp rebuild uses
#       --ensure and accepts the cache; preinstall.ts does not, see blockers)
#     - @vscode/ripgrep: TMPDIR=$SPIKE/tmp with tmp/vscode-ripgrep-cache-1.17.1/ripgrep-v15.0.1-x86_64-unknown-linux-musl.tar.gz
#       downloaded from https://github.com/microsoft/ripgrep-prebuilt/releases/download/v15.0.1/...
cd vscode
npm ci --no-audit --no-fund                       # dependency tree + native builds OK; its preinstall step fails here (403)
build/npm/gyp/node_modules/.bin/node-gyp install --dist-url https://electronjs.org/headers \
    --tarball ../node-dl/node-v24.21.0-headers.tar.gz 43.7.7     # manual replacement for the preinstall header step
npm_command=ci node build/npm/postinstall.ts      # manual replacement for the root postinstall step (nested npm ci x55)
( cd extensions/copilot && npm run postinstall )  # re-run with the default TMPDIR
# 4. overlay (see diff below), then:
# 5. build
npm run compile                                   # 151 s, out/ 452 MB
npm run compile-web                               # 38 s
# 6. web smoke (see ../run-web.sh and ../web-smoke-run2.sh)
git show HEAD:product.json > product.json && npm run download-builtin-extensions && cp ../product.json.overlay product.json
npm run gulp node                                 # remote Node 24.21.0 into .build/node (done by code-web.sh automatically)
.build/node/v24.21.0/linux-x64/node ./scripts/code-web.js --browserType none --port 8080
node ../smoke.mjs http://localhost:8080/ ../web-smoke2.png ../web-smoke2.json     # Playwright 1.64 + /opt/pw-browsers/chromium-1194
# 7. optional desktop check
npm run electron
VSCODE_SKIP_PRELAUNCH=1 xvfb-run -a ./scripts/code.sh --no-sandbox
```

Helper files in the spike dir: `env.sh`, `measure.sh` (wall time + peak tree RSS wrapper), `overlay_product.py`, `run-web.sh`, `web-smoke-run.sh` / `web-smoke-run2.sh`, `smoke.mjs`; logs: `npm-ci-attempt1.log`, `npm-ci-attempt2.log`, `npm-ci.log`, `postinstall.log`, `copilot-postinstall.log`, `compile-attempt1.log`, `compile.log`, `compile-web.log`, `web-server.log`, `web-server2.log`, `smoke.log`, `smoke2.log`, `electron-dl.log`, `electron-version.log`, `electron-version2.log`, `electron-run.log`, `electron-native-abi.log`, `builtin-ext-via-gallery.log`, `apt-get.log`; `*.measure` files hold the timing/RSS lines.

## product.json overlay (`git diff product.json`, also saved as `product.json.diff`)

Gallery keys copied verbatim from VSCodium's `prepare_vscode.sh` (`setpath_json "product" "extensionsGallery" ...`), plus their `linkProtectionTrustedDomains`. Upstream 1.141 reads these `extensionsGallery` keys (`src/vs/platform/extensionManagement/common/extensionGalleryManifestService.ts`): `serviceUrl` (the only required one), `itemUrl`, `publisherUrl`, `resourceUrlTemplate`, `extensionUrlTemplate`, `controlUrl`, `nlsBaseUrl`. VSCodium's `latestUrlTemplate` is not read by 1.141 (it derives `${serviceUrl}/vscode/{publisher}/{name}/latest` itself); it is harmless.

```diff
diff --git a/product.json b/product.json
index 64e1c4d2..7851e0fd 100644
--- a/product.json
+++ b/product.json
@@ -1,8 +1,8 @@
 {
-	"nameShort": "Code - OSS",
-	"nameLong": "Code - OSS",
-	"applicationName": "code-oss",
-	"dataFolderName": ".vscode-oss",
+	"nameShort": "Some IDE",
+	"nameLong": "Some IDE",
+	"applicationName": "some-ide",
+	"dataFolderName": ".some-ide",
 	"sharedDataFolderName": ".vscode-oss-shared",
 	"win32MutexName": "vscodeoss",
 	"licenseName": "MIT",
@@ -246,5 +246,14 @@
 		"GitHub.copilot-chat"
 	],
 	"sessionsWindowAllowedExtensions": [],
-	"voiceWsUrl": "wss://falcon-caas.mai.microsoft.com/voice-code/api/v1/realtime/voice"
+	"voiceWsUrl": "wss://falcon-caas.mai.microsoft.com/voice-code/api/v1/realtime/voice",
+	"extensionsGallery": {
+		"serviceUrl": "https://open-vsx.org/vscode/gallery",
+		"itemUrl": "https://open-vsx.org/vscode/item",
+		"latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest",
+		"controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json"
+	},
+	"linkProtectionTrustedDomains": [
+		"https://open-vsx.org"
+	]
 }
```

For the dev web workbench an additional, git-ignored `product.overrides.json` (same keys: nameShort, nameLong, applicationName, dataFolderName, extensionsGallery, linkProtectionTrustedDomains) was created next to product.json; copy kept at `product.overrides.json` in the spike dir. Not part of the overlay patch; see the smoke-test finding below.

## Web smoke test

Server: `scripts/code-web.js --browserType none --port 8080` (wraps `@vscode/test-web` 0.0.81 with `--sourcesPath`), built-in extensions synced from GitHub releases first. Browser: Playwright 1.64 from `/home/user/some-ide/node_modules`, Chromium 141 at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, headless, `--no-sandbox`.

| Pass | Config | `document.title` | Help > About dialog | "Some IDE" visible? | Screenshot |
|---|---|---|---|---|---|
| 1 | product.json overlay only | `Welcome - Workspace - Code - OSS Dev` | `Code - OSS Dev`, Version 1.104.0-dev | **no** | `web-smoke.png`, `web-smoke-about.png` |
| 2 | + `product.overrides.json` | `Welcome - Workspace - Some IDE` | `Some IDE`, Version 1.104.0-dev | **yes** (title, body text, About; gallery URLs present in the page's `productConfiguration`) | `web-smoke2.png`, `web-smoke2-about.png` |

Absolute paths: `/tmp/claude-0/-home-user-some-ide/783122e1-78db-54a3-843d-e85e162815ce/scratchpad/vscode-spike/web-smoke.png`, `.../web-smoke-about.png`, `.../web-smoke2.png`, `.../web-smoke2-about.png`; machine-readable results in `web-smoke.json` / `web-smoke2.json`.

Why pass 1 shows the wrong name: when the workbench runs from sources in a browser, `src/vs/platform/product/common/product.ts` falls back to a hard-coded `{ nameShort: 'Code - OSS Dev', version: '1.104.0-dev', ... }` and only merges the `productConfiguration` the embedding server injects into the page. Both `@vscode/test-web` (`out/server/workbench.js`, `getProductOverrides`) and the repo's own REH web server (`src/vs/server/node/webClientServer.ts`, non-built mode) read `<repo>/product.overrides.json` for that purpose, and the file is in upstream's `.gitignore`. In **built** web bundles (`gulp vscode-web`, `vscode-reh-web-*`) product.json is inlined, so the overlay applies without the overrides file. Only console error in both passes: one 404 for `out/vs/workbench/workbench.web.main.internal.css` (the dev server loads CSS per module; harmless). The server was stopped after each pass (nothing listening on :8080 at the end).

## Optional desktop (Electron) check

`npm run electron` downloaded Electron 43.7.7 from GitHub releases in 13 s. `./scripts/code.sh --version` under `xvfb-run -a`: first run died with `FATAL ... Running as root without --no-sandbox is not supported`; with `--no-sandbox` (and `VSCODE_SKIP_PRELAUNCH=1`, because the pre-launch step would re-download built-ins from the gallery) the dev app started a full workbench session (main-process logs, 480 CSS modules, storage service, chat services) until my 45 s / 120 s timeouts; the dev launcher does not short-circuit `--version`. ABI check in `ELECTRON_RUN_AS_NODE=1` mode: Electron 43.7.7 bundles Node 24.21.0 and reports module ABI 148; `@vscode/sqlite3`, `native-keymap`, `@vscode/spdlog`, `kerberos`, `@parcel/watcher` and `@vscode/native-watchdog` all load, even though they were compiled against Node 24.21.0 headers (they are Node-API modules; node-gyp's electron runtime mode stamps the Electron ABI). Real Electron headers should still be used on CI; no screenshot of the Electron window was taken.

## Blockers hit and how they were resolved

1. **Node version**: preinstall refuses Node 22 (`Please use Node.js v24.18.0 or newer with the same major version`). Resolved: local Node 24.18.0.
2. **Missing system libraries**: `kerberos` needs `libkrb5-dev` (`gssapi/gssapi.h`), `native-keymap` needs `libxkbfile-dev` (+ `libx11-dev`, already present). `libsecret-1-dev` is **not** needed by 1.141 (keytar is gone). Resolved with one `apt-get install` (11 s). Cost: npm rolls the whole tree back on a failed install script, so each failed `npm ci` wasted 2 to 4 minutes.
3. **electronjs.org blocked** (Electron 43.7.7 headers): `node-gyp rebuild` during `npm ci` honours a pre-seeded `$XDG_CACHE_HOME/node-gyp/43.7.7` (it calls install with `--ensure`), but `build/npm/preinstall.ts` runs `node-gyp install --dist-url ... 43.7.7` without `--ensure`, which always re-downloads and, on the 403, deletes the cache dir. There is no env override in preinstall.ts (only `VSCODE_SKIP_NODE_VERSION_CHECK`). Worked around by running the header install manually with node-gyp's `--tarball` option (Node 24.21.0 headers; the custom `build/npm/gyp/custom-headers` overlay for GCC < 13 was not applied, gcc is 13.3) and the root postinstall manually (`npm_command=ci node build/npm/postinstall.ts`). Not resolved for an unmodified `npm ci`: a runner must reach `electronjs.org/headers` (or the preinstall script must be patched to accept a mirror / `--tarball`).
4. **api.github.com blocked**: `@vscode/ripgrep` 1.17.1 (also pulled in by `remote/`) resolves the prebuilt asset through the GitHub API before downloading from `github.com/.../releases/download/...` (which works). Worked around by pre-seeding its cache file under `os.tmpdir()`; alternative is a `GITHUB_TOKEN` plus API access.
5. **open-vsx.org unreachable**: irrelevant for the build itself, but with `extensionsGallery.serviceUrl` set, `build/lib/builtInExtensions.ts` switches the built-in extension download (js-debug, js-debug-companion, js-profile-table) from GitHub releases to `${serviceUrl}/publishers/{publisher}/vsextensions/{name}/{version}/vspackage` and fails here with `getaddrinfo ENOTFOUND open-vsx.org` (`builtin-ext-via-gallery.log`). This affects `code-web.sh`, `code-server.sh`, `code.sh` (pre-launch) and the packaging tasks. Worked around by running the download with the upstream product.json. Even with network access the `sha256` values in product.json are those of the GitHub VSIX files, so Open VSX downloads would likely fail the checksum: the real repo needs a small patch (download built-ins from GitHub regardless of the gallery, or vendor them via the `vsix` key).
6. **Self-inflicted `TMPDIR`**: pointing `TMPDIR` at the long scratchpad path made `tsx` (used by `extensions/copilot`'s postinstall, which `compile-copilot` also invokes) fail with `listen EINVAL` on its Unix-socket path (108-byte limit). Removed the override; keep temp dirs short.
7. **Electron as root**: needs `--no-sandbox` (or a non-root user) on CI containers.
8. Not blockers but noted: the REH web server forwards `extensionsGallery` to the browser only when `resourceUrlTemplate` is set (`webClientServer.ts:399`); `compile-copilot` is part of `npm run compile` (the Copilot Chat extension now lives in-tree with its own 1.6 GB `node_modules`), and `npm-run-all2 -lp` aborts `compile-client` if it fails; `foundry-local-sdk` (root dependency) downloads NuGet packages from api.nuget.org at install time (`FOUNDRY_LOCAL_SKIP_INSTALL=1` exists); `@playwright/browser-chromium` is a dev dependency whose browser download was skipped via `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.

## What this means for the plan

- **CI runner**: Ubuntu 24.04 (or equivalent) with gcc 13, python3, make, pkg-config, `libx11-dev`, `libxkbfile-dev`, `libkrb5-dev`; Node from `.nvmrc` (24.18.0, npm < 13; the pin changes per release, so read `.nvmrc` in CI rather than hard-coding); >= 4 vCPU; **16 GB RAM** (compile peaked at ~10 GB summed tree RSS with `--max-old-space-size=8192` for gulp; 8 GB runners are likely to OOM); >= 20 GB free disk per checkout (9 GB used here before any packaging); xvfb and `--no-sandbox` for any Electron smoke test; non-root user preferred.
- **Egress allowlist**: registry.npmjs.org, nodejs.org, electronjs.org + artifacts.electronjs.org (headers), github.com + release-assets/objects.githubusercontent.com, api.github.com (ripgrep), raw.githubusercontent.com (controlUrl, VSCodium references), api.nuget.org (foundry-local-sdk), open-vsx.org (gallery, and built-ins unless patched), plus the apt mirror. Mirrors/caches are worth it: the dependency install is ~9 min and 4 GB of node_modules per checkout.
- **Time budget** (4 vCPU): clone 10 s, install ~9 min, `compile` ~2.5 min, `compile-web` ~40 s, Electron download 15 s; a full dev cycle is ~15 min. A production package (`gulp vscode-linux-x64-min` etc.) was not measured and will be longer.
- **Overlay as a patch**: the four name keys plus `extensionsGallery` and `linkProtectionTrustedDomains` are enough for the build and the web/desktop workbench. Expect to also rename `sharedDataFolderName`, `serverApplicationName`, `serverDataFolderName`, `tunnelApplicationName`, `urlProtocol`, `linuxDesktopName`, `linuxIconName`, `win32*`, `darwinBundleIdentifier` and `reportIssueUrl` later, as VSCodium does. Add `resourceUrlTemplate` (`https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}`) if a server/web distribution is planned.
- **Two extra patches are needed** beyond product.json: (a) keep built-in extensions coming from GitHub (or vendor VSIX files) when a gallery is configured; (b) for the dev web/server workflow, generate `product.overrides.json` from the overlay (or accept that only built web bundles show the name). On a network like this one, a third patch (mirror/`--tarball` support in `build/npm/preinstall.ts`) would also be needed; on open egress it is not.
- **Upstream drift to watch**: build scripts are now TypeScript run with `--experimental-strip-types` (`build/npm/*.ts`, `build/lib/*.ts`), the Copilot Chat extension is compiled as part of `npm run compile`, and the gallery configuration moved to a manifest service; the overlay keys above are current for 1.141.0 and should be re-checked on each upstream bump.
