#!/bin/bash
# Mind · macOS 双击入口。
#
# Mind 已经整合进 Toolset：这个脚本只负责确保 Toolset 在跑，然后打开
# http://127.0.0.1:8770/tools/mind/
#
# 第一次如果提示「无法打开，因为来自身份不明的开发者」：右键 → 打开；
# 或者在终端执行一次：chmod +x Mind.command

set -u

cd "$(dirname "$0")" || exit 1
TOOLSET="$(cd ../.. && pwd)"
SERVER="$TOOLSET/server.py"

say() { printf '  %s\n' "$*"; }

pause_close() {
  if [ -t 0 ]; then
    printf '  按 Enter 关闭'
    read -r _ || true
  fi
}

if [ ! -f "$SERVER" ]; then
  say ""
  say "找不到 Toolset 服务：$SERVER"
  say "请确认 Documents/Toolset 还在。"
  say ""
  pause_close
  exit 1
fi

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  fi
done

if [ -z "$PY" ]; then
  say ""
  say "找不到 Python 3.10 以上。"
  say "装一个：https://www.python.org/downloads/  或  brew install python"
  say ""
  pause_close
  exit 1
fi

NO_OPEN=0
for arg in "$@"; do
  if [ "$arg" = "--no-open" ]; then NO_OPEN=1; fi
done

if [ "$NO_OPEN" -eq 1 ]; then
  exec "$PY" "$SERVER" --open-tool mind --no-open
else
  exec "$PY" "$SERVER" --open-tool mind
fi
