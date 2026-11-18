#!/bin/zsh
# 下载并安装 macOS 便携版 Node.js 运行时（含 npm），curl 自带进度条；node 已存在时直接返回。
# 用法： packaging/bootstrap-runtime.sh <runtime 目录> [arm64|x64]
# 可用 CW_NODE_MIRROR 覆盖下载源（默认官方 https://nodejs.org/dist）。
set -euo pipefail

dest="${1:?用法: bootstrap-runtime.sh <runtime 目录> [arm64|x64]}"
arch="${2:-$(uname -m)}"
if [ "$arch" = "x86_64" ]; then arch="x64"; fi
if [ "$arch" != "arm64" ] && [ "$arch" != "x64" ]; then
  echo "不支持的架构： $arch（仅支持 arm64 / x64）" >&2
  exit 1
fi
if [ -x "$dest/bin/node" ]; then exit 0; fi

mirror="${CW_NODE_MIRROR:-https://nodejs.org/dist}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cw-runtime-XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# 官方 macOS 发行包为 darwin-<arch>.tar.gz，SHA-256 来自 SHASUMS256.txt。
echo "正在获取 Node.js 版本信息： $mirror/latest-v24.x/SHASUMS256.txt"
line="$(curl -fsSL "$mirror/latest-v24.x/SHASUMS256.txt" | grep -E "node-v24\.[0-9]+\.[0-9]+-darwin-$arch\.tar\.gz$" | head -1)"
if [ -z "$line" ]; then echo "无法定位官方 Node.js macOS $arch 发行包" >&2; exit 1; fi
expected="$(printf '%s\n' "$line" | awk '{print $1}')"
file="$(printf '%s\n' "$line" | awk '{print $2}')"
version="v${file#node-v}"; version="${version%%-*}"
url="$mirror/$version/$file"

echo "下载 $url"
curl -fL -o "$tmp/$file" "$url"

actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"
if [ "$actual" != "$expected" ]; then echo "Node.js 校验失败： SHA-256 不匹配" >&2; exit 1; fi
echo "校验通过，正在解压..."

tar -xzf "$tmp/$file" -C "$tmp"
dir="$tmp/node-$version-darwin-$arch"
if [ ! -x "$dir/bin/node" ]; then echo "解压结果中缺少 node 可执行文件" >&2; exit 1; fi
rm -rf "$dest"
mv "$dir" "$dest"
echo "Node.js $version 已就绪： $dest/bin/node"
