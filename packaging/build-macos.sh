#!/bin/zsh
# 构建 macOS 绿色版 ZIP：内置 Node 运行时、依赖与前端产物，解压即用。
# 用法： packaging/build-macos.sh [arm64|x64]（默认当前架构）
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
arch="${1:-$(uname -m)}"
if [ "$arch" = "x86_64" ]; then arch="x64"; fi

work="$(mktemp -d "${TMPDIR:-/tmp}/cw-build-XXXXXX")"
trap 'rm -rf "$work"' EXIT
stage="$work/crazywaterworld"
out="$root/output"
mkdir -p "$stage" "$out"

# 只打包已提交内容，绝不携带本机凭据或缓存。
git archive --format=tar --output="$work/source.tar" HEAD
tar -xf "$work/source.tar" -C "$stage"
for name in .github data work certificates output node_modules build release; do
  rm -rf "$stage/$name"
done

# 官方 Node 运行时（含 npm），SHA-256 校验；与 start.command 复用同一引导脚本。
"$root/packaging/bootstrap-runtime.sh" "$stage/runtime" "$arch"

export PATH="$stage/runtime/bin:$PATH"
(
  cd "$stage"
  ./runtime/bin/node --version
  ./runtime/bin/npm ci --include=dev
  ./runtime/bin/npm run build:ui
)

cat > "$stage/start.command" <<'EOF'
#!/bin/zsh
cd "$(dirname "$0")"
if [ ! -x runtime/bin/node ]; then
  echo "Node.js runtime missing. Downloading with progress bar..."
  if ! sh packaging/bootstrap-runtime.sh "$PWD/runtime" "$(uname -m)"; then
    echo "Failed to download Node.js runtime. Check the network and retry."
    read -r "?Press Enter to exit..."
    exit 1
  fi
fi
export PATH="$PWD/runtime/bin:$PATH"
./runtime/bin/npm start
code=$?
if [ "$code" -ne 0 ]; then read -r "?Console exited with code $code. Press Enter to close..."; fi
exit "$code"
EOF

cat > "$stage/terminal.command" <<'EOF'
#!/bin/zsh
cd "$(dirname "$0")"
export PATH="$PWD/runtime/bin:$PATH"
exec zsh
EOF
chmod +x "$stage/start.command" "$stage/terminal.command"

cat > "$stage/PORTABLE.md" <<'EOF'
# macOS portable build
Extract to a writable folder. Follow the README to prepare the local game protocol before starting. Double-click start.command to run the local console.
Double-click terminal.command to use the bundled node and npm commands.
If runtime/bin/node is missing, start.command downloads the official Node.js
runtime automatically (SHA-256 verified, with a progress bar).
Keep data/ and work/ when upgrading. Game clients, local game protocol
packages and any required browser downloads are still prerequisites
as described in the README. No credentials are bundled.
Packaging-only changes: portable runtime, dependencies and launcher scripts.
See LICENSE, runtime/LICENSE and dependency licenses.
EOF
git rev-parse HEAD > "$stage/BUILD-COMMIT.txt"

# 先压缩再冒烟，测试产生的数据与日志不会进入分发包；ditto 保留可执行权限。
zip="$out/crazywaterworld-macos-$arch.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$stage" "$zip"

# 解压到带空格的目录，验证真实产物。
testDir="$work/extracted test"
mkdir -p "$testDir"
ditto -x -k "$zip" "$testDir"
test="$testDir/crazywaterworld"
export CW_NO_BROWSER=1 CW_RESOURCE_AUTO_UPDATE=0 CW_PORT=17421
export PATH="$test/runtime/bin:$PATH"
(
  cd "$test"
  ./runtime/bin/node --version
  ./runtime/bin/npm --version
  # 真实控制台需要用户本机的游戏协议包：先验证缺协议时的拒绝行为，
  # 再用与 HTTP 回归一致的离线依赖注入方式冒烟。测试文件在压缩之后创建，不会随包分发。
  cat > portable-smoke-test.mjs <<'SMOKE'
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
SMOKE
  ./runtime/bin/node ./portable-smoke-test.mjs
)
shasum -a 256 "$zip"
echo "已生成 $zip"
