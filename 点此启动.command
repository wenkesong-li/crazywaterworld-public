#!/bin/zsh
# 双击启动控制台：自动准备 Node 运行时（缺失时带进度条下载）与依赖，然后启动。
cd "$(dirname "$0")" || exit 1
if [ ! -x runtime/bin/node ]; then
  echo "首次运行：正在下载 Node.js 运行时（带进度条）..."
  if ! sh packaging/bootstrap-runtime.sh "$PWD/runtime" "$(uname -m)"; then
    echo "Node.js 下载失败，请检查网络后重试。"
    read -r "?按回车键退出..."
    exit 1
  fi
fi
export PATH="$PWD/runtime/bin:$PATH"
if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖（约 1-3 分钟）..."
  if ! ./runtime/bin/npm ci; then
    echo "依赖安装失败，请检查网络后重试。"
    read -r "?按回车键退出..."
    exit 1
  fi
fi
echo "启动控制台..."
./runtime/bin/npm start
code=$?
if [ "$code" -ne 0 ]; then read -r "?控制台退出（代码 $code），按回车键关闭..."; fi
exit "$code"
