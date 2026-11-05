#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mind 的 Toolset 后端：找文档、检查路径、清掉已审批的提案。

静态文件由 Toolset 的统一 server 直接服务；这里只保留需要读写磁盘的接口。
前端仍然用相对路径 `api/...` 和 `proposals/...`，所以挂在 /tools/mind/ 下
不需要改页面。
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
PROPOSALS = HERE / "proposals"

try:
    sys.path.insert(0, str(HERE))
    import propose as prop
except Exception:
    prop = None


# ------------------------------------------------------------------ pending


def read_index_rows(pd: Path):
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


def write_index(pd: Path, rows):
    body = "\n".join(name + "\t" + doc for name, doc in rows)
    (pd / "index.txt").write_text(
        (body + "\n") if rows else "", encoding="utf-8", newline="\n"
    )


def rebuild_pending(pd: Path):
    """和 propose.py 的 rebuild_pending 同一份格式，file:// 那条路才互通。"""
    rows = [
        {
            "file": name,
            "doc": doc,
            "text": (pd / name).read_text(encoding="utf-8-sig"),
        }
        for name, doc in read_index_rows(pd)
    ]
    (pd / "pending.js").write_text(
        "window.__MIND_PROPOSALS__ = " + json.dumps(rows, ensure_ascii=True) + ";\n",
        encoding="utf-8",
        newline="\n",
    )


# ------------------------------------------------------------------ find

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


def find_roots(here: Path):
    """先近后远：工具目录、它的上级、Toolset，再是用户目录里放东西的地方。"""
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
    for sub in (
        "Documents",
        "Desktop",
        "Downloads",
        "OneDrive",
        "OneDrive/Documents",
        "OneDrive/Desktop",
    ):
        add(home / sub)
    add(home)
    return roots


def doc_fingerprint(path: Path):
    if prop is None:
        return ""
    try:
        if path.stat().st_size > FIND_MAX_BYTES:
            return ""
        return prop.tree_hash(prop.parse_outline(prop.read(path), path.stem))
    except (OSError, ValueError, UnicodeError):
        return ""


def find_doc(here: Path, name: str, want_hash: str):
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
                d
                for d in dirnames
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


# ------------------------------------------------------------------ API


def handle_api(method: str, path: str, query: dict, body: dict):
    query = query or {}
    if method == "GET" and path == "/where":
        return 200, {"root": str(HERE), "propose": str(HERE / "propose.py")}

    if method == "GET" and path == "/find":
        name = (query.get("name") or [""])[0].strip()
        want = (query.get("hash") or [""])[0].strip().lower()
        if not name or "/" in name or "\\" in name or ".." in name:
            return 400, {"path": None, "match": ""}
        if want and not re.fullmatch(r"[0-9a-f]{8}", want):
            want = ""
        hit, how = find_doc(HERE, name, want)
        return 200, {"path": str(hit) if hit else None, "match": how}

    if method == "GET" and path == "/check":
        raw = (query.get("path") or [""])[0].strip()
        ok = False
        if raw:
            try:
                ok = Path(raw).is_file()
            except (OSError, ValueError):
                ok = False
        return 200, {"file": ok}

    return 404, {"ok": False, "error": "没有这个接口。"}


def handle_delete(path: str, query: dict):
    prefix = "/proposals/"
    if not path.startswith(prefix) or not path.endswith(".proposal"):
        return 403, {"ok": False, "error": "only .proposal under /proposals/"}
    name = unquote(path[len(prefix) :])
    if "/" in name or "\\" in name or ".." in name:
        return 403, {"ok": False, "error": "bad path"}

    target = PROPOSALS / name
    try:
        if PROPOSALS.resolve() not in target.resolve().parents:
            return 403, {"ok": False, "error": "bad path"}
    except OSError:
        return 403, {"ok": False, "error": "bad path"}

    rows = read_index_rows(PROPOSALS)
    if not target.exists() and not any(row[0] == name for row in rows):
        return 404, {"ok": False, "error": "no such proposal"}
    try:
        if target.exists():
            target.unlink()
        write_index(PROPOSALS, [row for row in rows if row[0] != name])
        rebuild_pending(PROPOSALS)
    except OSError as exc:
        return 500, {"ok": False, "error": str(exc)}
    return 204, None
