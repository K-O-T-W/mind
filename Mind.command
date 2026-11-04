#!/bin/bash
# Mind —— macOS 双击入口。
#
# 在 Finder 里双击这个文件：它起一个只监听 127.0.0.1 的小服务，再用默认浏览器
# 打开页面。这个终端窗口就是开关，关掉它服务就停。
#
# 端口默认 8765，想换：./Mind.command 8766
#
# 第一次如果提示「无法打开，因为来自身份不明的开发者」：右键 → 打开；
# 或者在终端执行一次：chmod +x Mind.command

set -u

cd "$(dirname "$0")" || exit 1

PORT="${1:-8765}"
URL="http://127.0.0.1:${PORT}/"

say() { printf '  %s\n' "$*"; }

pause_close() {
  if [ -t 0 ]; then
    printf '  按 Enter 关闭'
    read -r _ || true
  fi
}

port_busy() {
  # bash 自带的 /dev/tcp：只连一下，能连上就算有人占着。
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") >/dev/null 2>&1
}

is_mind() {
  # 不只看端口通不通：页面里得有这个工具自己的标记，免得把别的服务当成它。
  curl -fsS --max-time 2 "$URL" 2>/dev/null | grep -q 'id="reviewChip"'
}

if port_busy; then
  if is_mind; then
    say ""
    say "已经在运行：$URL"
    say "直接切过去就行，不用再开一个。"
    say ""
    open "$URL"
    exit 0
  fi
  say ""
  say "端口 $PORT 被别的程序占着。"
  say "换一个端口：./Mind.command 8766"
  say ""
  pause_close
  exit 1
fi

# 优先 python3。macOS 自带的是 3.9 起步；太老的不要，server.py 用不了。
PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  fi
done

if [ -z "$PY" ]; then
  say ""
  say "找不到 Python 3.9 以上。"
  say "装一个：https://www.python.org/downloads/  或  brew install python"
  say "装完再双击一次。"
  say ""
  pause_close
  exit 1
fi

LOG_OUT="$(mktemp "${TMPDIR:-/tmp}/mind-server-out.XXXXXX")"
LOG_ERR="$(mktemp "${TMPDIR:-/tmp}/mind-server-err.XXXXXX")"

"$PY" server.py "$PORT" --bind 127.0.0.1 --directory . >"$LOG_OUT" 2>"$LOG_ERR" &
PID=$!

cleanup() {
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -f "$LOG_OUT" "$LOG_ERR"
}
trap cleanup EXIT INT TERM HUP

READY=0
i=0
while [ "$i" -lt 100 ]; do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  if is_mind; then READY=1; break; fi
  sleep 0.1
  i=$((i + 1))
done

if [ "$READY" -ne 1 ]; then
  say ""
  say "没有起来。"
  if [ -s "$LOG_ERR" ]; then
    tail -n 6 "$LOG_ERR" 2>/dev/null | sed 's/^/    /'
  fi
  say ""
  pause_close
  exit 1
fi

say ""
say "Mind"
say "$URL"
say ""
say "文件  $(pwd)"
say "这个窗口就是开关，关掉它服务就停（或按 Ctrl+C）。"
say ""
open "$URL"

wait "$PID"
