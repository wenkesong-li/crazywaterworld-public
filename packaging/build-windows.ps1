$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
# Actions 上用 RUNNER_TEMP；本地 Windows 构建时退回系统临时目录。
$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$work = Join-Path $base ('cw-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$stage = Join-Path $work 'crazywaterworld'
$out = Join-Path $root 'output'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
New-Item -ItemType Directory -Force $stage, $out | Out-Null

# Start with tracked source only. Never package local credentials or caches.
$source = Join-Path $work 'source.tar'
git archive --format=tar "--output=$source" HEAD
& $tar -xf $source -C $stage
foreach ($name in @('.github', 'data', 'work', 'certificates', 'output', 'node_modules')) {
    $p = Join-Path $stage $name
    if (Test-Path $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}

# Official Windows Node distribution, including npm, verified by SHA-256.
# bootstrap-runtime.ps1 shows a progress bar and is reused by start.cmd at
# user startup when the bundled runtime is missing.
$runtime = Join-Path $stage 'runtime'
& (Join-Path $PSScriptRoot 'bootstrap-runtime.ps1') -Destination $runtime -TempDirectory (Join-Path $work 'node-download')

# Build using precisely the Node/npm that the user will receive.
$env:PATH = "$runtime;$env:PATH"
Push-Location $stage
try {
    & "$runtime\node.exe" --version
    & "$runtime\npm.cmd" ci --include=dev
    & "$runtime\npm.cmd" run build:ui
} finally { Pop-Location }

@'
@echo off
set "PATH=%~dp0runtime;%PATH%"
'@ | Set-Content (Join-Path $stage 'env.cmd') -Encoding ascii

@'
@echo off
setlocal
cd /d "%~dp0"
call "%~dp0env.cmd"
if not exist "%~dp0runtime\node.exe" (
    echo Node.js runtime missing. Downloading with progress bar...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\bootstrap-runtime.ps1" -Destination "%~dp0runtime"
    if errorlevel 1 (
        echo Failed to download Node.js runtime. Check the network and retry.
        pause
        exit /b 1
    )
)
call "%~dp0runtime\npm.cmd" start %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" pause
exit /b %code%
'@ | Set-Content (Join-Path $stage 'start.cmd') -Encoding ascii

@'
@echo off
setlocal
cd /d "%~dp0"
call "%~dp0env.cmd"
cmd /k
'@ | Set-Content (Join-Path $stage 'terminal.cmd') -Encoding ascii

@'
# Windows portable build
Extract to a writable folder. Follow the README to prepare the local game protocol before starting. Double-click start.cmd to run the local console.
Double-click terminal.cmd to use the bundled node and npm commands.
The original start-console.cmd can also be run from that terminal.
If runtime/node.exe is missing, start.cmd downloads the official Node.js
runtime automatically (SHA-256 verified, with a progress bar).
Keep data/ and work/ when upgrading. Game clients, local game protocol
packages and any required browser downloads are still prerequisites
as described in the README. No credentials are bundled.
Packaging-only changes: portable runtime, dependencies and CMD launchers.
See LICENSE, runtime/LICENSE and dependency licenses.
'@ | Set-Content (Join-Path $stage 'PORTABLE.md') -Encoding utf8
git rev-parse HEAD | Set-Content (Join-Path $stage 'BUILD-COMMIT.txt') -Encoding ascii

# Archive before smoke-testing so temporary test data and logs are not shipped.
$zip = Join-Path $out 'crazywaterworld-win-x64.zip'
if (Test-Path $zip) { Remove-Item $zip }
& $tar -a -cf $zip -C $work crazywaterworld

# Validate the actual extracted ZIP in a different directory (with a space).
$testDir = Join-Path $work 'extracted test'
New-Item -ItemType Directory $testDir | Out-Null
& $tar -xf $zip -C $testDir
$test = Join-Path $testDir 'crazywaterworld'
$testRuntime = Join-Path $test 'runtime'
$env:PATH = "$testRuntime;$env:SystemRoot\System32;$env:SystemRoot"
$env:CW_NO_BROWSER = '1'
$env:CW_RESOURCE_AUTO_UPDATE = '0'
$env:CW_PORT = '17421'
$node = Join-Path $testRuntime 'node.exe'
Push-Location $test
try {
    & $node --version
    & "$testRuntime\npm.cmd" --version
    # The real console requires a game protocol from the user's local client.
    # Validate its failure mode without a protocol, then use the same offline
    # dependency-injection approach as the upstream HTTP regression tests.
    # The smoke-test files are created AFTER compression and are never shipped.
    @'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = import.meta.dirname;
process.env.CW_DATA_DIR = path.join(root, 'data');
process.env.CW_RESOURCE_DIR = path.join(root, 'work', 'test-resources');
process.env.CW_PROTO_BUNDLE = path.join(root, 'missing-game-protocol.js');
const config = path.join(root, 'offline-test-config.json');
fs.writeFileSync(config, '[]');
process.env.CW_CONFIG_PACK = config;

const startup = spawnSync(process.execPath, ['src/app.mjs', 'console'], {
  cwd: root, env: process.env, encoding: 'utf8', timeout: 30000,
});
if (startup.error) throw startup.error;
assert.equal(startup.status, 1, 'Expected real startup to reject a missing game protocol');
assert.match(startup.stdout + startup.stderr, /ENOENT|无法加载当前协议/);
console.log('Real startup: missing game protocol correctly rejected.');

const { createConsole } = await import('./src/server.mjs');
const app = createConsole({ port: 0, protocol: {}, resourceUpdates: false });
const watchdog = setTimeout(() => {
  console.error('Offline HTTP smoke test timed out');
  process.exit(1);
}, 30000);
try {
  const url = await app.listen();
  const page = await fetch(url + '/', { signal: AbortSignal.timeout(10000) });
  assert.equal(page.status, 200, 'Console HTML');
  assert.ok((await page.text()).length > 0);
  const js = await fetch(url + '/ui/console-client.js', { signal: AbortSignal.timeout(10000) });
  assert.equal(js.status, 200, 'Bundled client JS');
  assert.ok((await js.arrayBuffer()).byteLength > 0);
  console.log('Portable ZIP offline HTTP smoke test passed.');
} finally {
  try { await app.close(); } finally { clearTimeout(watchdog); }
}
'@ | Set-Content (Join-Path $test 'portable-smoke-test.mjs') -Encoding utf8
    & $node './portable-smoke-test.mjs'
} finally { Pop-Location }
Get-FileHash $zip -Algorithm SHA256 | Format-List
