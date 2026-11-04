#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""产品定义的本地服务：静态文件 + 两个小接口 + 一个 DELETE。

为什么不用 `python -m http.server`：它只有 GET。页面把一份提案审批完之后，
应该把 proposals/ 里那份 .proposal 从磁盘上清掉；http.server 做不到，只能
靠浏览器 localStorage 记「已处理」——换个浏览器、清一次存储，已经生效过的
提案还会再弹出来，再点一遍接受就是重复写入。

这里在静态服务上加一条 DELETE /proposals/<名字>.proposal：删掉文件、从
index.txt 里去掉那一行、重建 pending.js——和 `propose.py clean` 做的是同一
件事，格式也逐字对齐，两条路随便混用。

GET 与 http.server 还有一处不同：所有响应都带 Cache-Control: no-cache。
浏览器永远先回源验证再用品——正常按一次 F5 必定拿到最新代码，不用 Ctrl+F5，
文件没变时走 304 也不慢。

另外两个 GET 是给左下角那个「让 AI 改」用的：

    GET /api/where                  -> {"root": "...", "propose": "..."}
    GET /api/find?name=x.md&hash=..  -> {"path": "...", "match": "hash"|"name"}
    GET /api/check?path=...         -> {"file": true|false}

浏览器的文件系统句柄只给文件名，绝对路径拿不到；页面要往提示词里写「文件在
哪儿」，只能回来问这个进程——它就是那个目录，也是那台机器上的 Python。

用法（mind.ps1 已经改用它）：

    python server.py 8765 --bind 127.0.0.1 --directory .
"""

import argparse
import json
import os
import re
import sys
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

HERE = Path(__file__).resolve().parent

# 树指纹必须和页面算的一模一样，所以直接用 propose.py 那份实现：两边各写一份，
# 迟早会分叉，到时候「明明是同一条树」却对不上，比没有指纹更糟。
try:
    sys.path.insert(0, str(HERE))
    import propose as prop
except Exception:            # 导入失败就退化成只按文件名找
    prop = None


# ------------------------------------------------------------------ pending

def read_index_rows(pd):
    """index.txt 一行「文件名<TAB>文档名」，只留文件还在的行。"""
    rows = []
    index = pd / "index.txt"
    if index.exists():
        for line in index.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split("\t")
            if len(parts) < 2:
                continue
            if not (pd / parts[0]).exists():
                continue
            rows.append((parts[0], parts[1]))
    return rows


def write_index(pd, rows):
    body = "\n".join(name + "\t" + doc for name, doc in rows)
    (pd / "index.txt").write_text((body + "\n") if rows else "", encoding="utf-8", newline="\n")


def rebuild_pending(pd):
    """和 propose.py 的 rebuild_pending 同一份格式，file:// 那条路才互通。"""
    rows = [
        {"file": name, "doc": doc, "text": (pd / name).read_text(encoding="utf-8-sig")}
        for name, doc in read_index_rows(pd)
    ]
    (pd / "pending.js").write_text(
        "window.__MIND_PROPOSALS__ = " + json.dumps(rows, ensure_ascii=True) + ";\n",
        encoding="utf-8",
        newline="\n",
    )


# ------------------------------------------------------------------ find

# 「这份 .md 到底在磁盘的哪儿？」——页面答不了（文件句柄只给名字），只能问这里。
# 两条腿一起走：先按文件名筛，再拿树指纹确认。指纹由 propose.py 和页面各算一遍，
# 同一个文件两边必须一模一样，所以「名字 + 指纹」都对上就是同一个文件，不是猜。
#
# 用户目录整棵翻是几万个名字，但 os.walk 只读目录项、不 stat，几百毫秒的量级；
# AppData / target / node_modules 这些一看就不该翻的直接跳过，再设个总时限。
FIND_SKIP = {
    ".git", ".hg", ".svn", ".vs", ".vscode", ".idea", ".workbuddy",
    "__pycache__", "node_modules", "target", "bin", "obj", "dist", "build",
    "packages", "venv", ".venv", ".conda", ".cargo", ".rustup", ".cache",
    ".npm", ".nuget", "site-packages", "appdata", "$recycle.bin",
}
FIND_DEPTH = 6
FIND_FILES = 60000
FIND_SECONDS = 2.5
FIND_MAX_BYTES = 8 << 20
FIND_CACHE = {}


def find_roots(here):
    """先近后远：工具目录、它的上级、再上一级，然后是用户目录里放东西的地方。"""
    roots = []

    def add(path):
        try:
            path = path.resolve()
        except OSError:
            return
        if path.is_dir() and path not in roots:
            roots.append(path)

    add(here)
    add(here.parent)
    add(here.parent.parent)
    home = Path.home()
    for sub in ("Documents", "Desktop", "Downloads", "OneDrive", "OneDrive/Documents", "OneDrive/Desktop"):
        add(home / sub)
    add(home)
    return roots


def doc_fingerprint(path):
    if prop is None:
        return ""
    try:
        if path.stat().st_size > FIND_MAX_BYTES:
            return ""
        return prop.tree_hash(prop.parse_outline(prop.read(path)))
    except (OSError, ValueError, UnicodeError):
        return ""


def find_doc(here, name, want_hash):
    """返回 (路径, 'hash'|'name'|'')。同一个问题问第二次直接给缓存。"""
    key = (name.lower(), want_hash)
    if key in FIND_CACHE:
        return FIND_CACHE[key]

    want = name.lower()
    deadline = time.monotonic() + FIND_SECONDS
    budget = FIND_FILES
    weak = None

    for root in find_roots(here):
        if time.monotonic() > deadline or budget <= 0:
            break
        base = len(root.parts)
        for dirpath, dirnames, filenames in os.walk(root):
            if time.monotonic() > deadline or budget <= 0:
                break
            depth = len(Path(dirpath).parts) - base
            dirnames[:] = [
                d for d in dirnames
                if depth < FIND_DEPTH and d.lower() not in FIND_SKIP and not d.startswith(".")
            ]
            budget -= len(filenames)
            for fname in filenames:
                if fname.lower() != want:
                    continue
                hit = Path(dirpath) / fname
                if weak is None:
                    weak = hit
                if not want_hash:
                    FIND_CACHE[key] = (hit, "name")
                    return hit, "name"
                if doc_fingerprint(hit) == want_hash:
                    FIND_CACHE[key] = (hit, "hash")
                    return hit, "hash"

    if weak is not None:
        FIND_CACHE[key] = (weak, "name")
        return weak, "name"
    FIND_CACHE[key] = (None, "")
    return None, ""


# ------------------------------------------------------------------ server

class MindHandler(SimpleHTTPRequestHandler):
    # 缓存头是这里和 http.server 唯一的行为差异，也是必须补的：
    # http.server 不发任何 Cache-Control，浏览器按 Last-Modified 启发式猜新鲜度，
    # 文件越老猜得越久——改完源码普通刷新还在跑旧 JS，就是这个坑。
    # no-cache = 可以存，但每次用之前必须回源验证：没变走 304，变了立刻拿新的。
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # 三个只读小接口：工具在哪、这份文档在哪、这个路径在不在。

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path == "/api/where":
            root = Path(self.directory).resolve()
            self.send_json({"root": str(root), "propose": str(root / "propose.py")})
            return

        if parts.path == "/api/find":
            q = parse_qs(parts.query)
            name = (q.get("name") or [""])[0].strip()
            want = (q.get("hash") or [""])[0].strip().lower()
            if not name or "/" in name or "\\" in name or ".." in name:
                self.send_json({"path": None, "match": ""}, 400)
                return
            if want and not re.fullmatch(r"[0-9a-f]{8}", want):
                want = ""
            hit, how = find_doc(Path(self.directory).resolve(), name, want)
            self.send_json({"path": str(hit) if hit else None, "match": how})
            return

        if parts.path == "/api/check":
            raw = (parse_qs(parts.query).get("path") or [""])[0].strip()
            ok = False
            if raw:
                try:
                    ok = Path(raw).is_file()
                except (OSError, ValueError):
                    ok = False
            self.send_json({"file": ok})
            return

        super().do_GET()

    # 静态部分照旧；只加一个 do_DELETE，且只认 proposals/ 里的 .proposal。

    def do_DELETE(self):
        path = urlsplit(self.path).path
        prefix = "/proposals/"
        if not path.startswith(prefix) or not path.endswith(".proposal"):
            self.send_error(403, "only .proposal under /proposals/")
            return
        name = unquote(path[len(prefix):])
        if "/" in name or "\\" in name or ".." in name:
            self.send_error(403, "bad path")
            return

        pd = Path(self.directory) / "proposals"
        target = pd / name
        try:
            if pd.resolve() not in target.resolve().parents:
                self.send_error(403, "bad path")
                return
        except OSError:
            self.send_error(403, "bad path")
            return

        rows = read_index_rows(pd)
        if not target.exists() and not any(r[0] == name for r in rows):
            self.send_error(404, "no such proposal")
            return
        try:
            if target.exists():
                target.unlink()
            write_index(pd, [r for r in rows if r[0] != name])
            rebuild_pending(pd)
        except OSError as err:
            self.send_error(500, str(err))
            return

        self.send_response(204)
        self.end_headers()


def main(argv):
    ap = argparse.ArgumentParser(description="mind static server + proposal DELETE")
    ap.add_argument("port", nargs="?", type=int, default=8765)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--directory", default=str(Path(__file__).resolve().parent))
    args = ap.parse_args(argv)

    root = Path(args.directory).resolve()
    if not (root / "index.html").exists():
        print(f"no index.html under {root} -- check --directory", file=sys.stderr)
        return 2

    handler = partial(MindHandler, directory=str(root))
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f"serving {root} at http://{args.bind}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
