#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为一份 Mind 大纲写「待审批的修改提案」。

AI 不直接改 .md。它把改动写成一份操作清单，这个程序拿当前大纲校验一遍，
生成一份提案；Mind 打开这份文档时会把提案铺在画布上，由人一条条点接受或
拒绝。人没点接受，磁盘上的 .md 一个字都不会变。

    python propose.py tree   产品定义.md
    python propose.py write  产品定义.md ops.txt
    python propose.py check  产品定义.md ops.txt
    python propose.py clean  产品定义.md

操作清单（一行一条，正文取行尾原样；多行用 << >> 包起来）：

    rename 2.3 新的名字
    note 2.3 <<
    第一行
    第二行
    >>
    add 2.3 <<
    新的子节点
      孙节点
    >>
    add - <<
    全新的一簇
    >>
    del 1.4

路径就是 `tree` 打印出来的编号：`1` 是第一个顶节点，`1.2` 是它的第二个
子节点，`-` 表示「新增一个顶层节点」。路径永远相对提案写下的那一刻。

改动可以打包成「修改块」——几处改动其实是同一件事时必须这样写，否则审批的
人只看到几个孤立的删除，不知道它们加起来在干什么：

    begin 去冗余 · 坐标系的三处重复
    why 这三条说的是同一件事。留 1.3.2 里最完整的那条，另外两条删掉。
    drop 1.3.4
    drop 2.1.1
    rename 3.2 坐标系（唯一声明）
    end

`begin` 后面是块的标题，`why` 是写给人看的说明（可以 `why <<` 写多行），
块里照常写操作，`end` 收口。块不能嵌套。审批界面里块是一节：可以展开看
里面每一条，也可以整块接受或拒绝。
"""

import json
import re
import sys
from pathlib import Path

POS_RE = re.compile(r"\s*<!--@(-?\d+),(-?\d+)-->\s*$")
OP_RE = re.compile(r"^(rename|note|add|del|drop|move)\s+(\S+)\s?(.*)$")
BEGIN_RE = re.compile(r"^begin(?:\s+(.*))?$")
WHY_RE = re.compile(r"^why(?:\s+(.*))?$")
BLOCK_KINDS = {"note", "add"}
HERE = Path(__file__).resolve().parent
PROPOSAL_DIR = HERE / "proposals"


# ------------------------------------------------------------------ outline

def title_key(value):
    text = str(value or "").strip().lower()
    text = re.sub(r"\.(md|markdown|mind|txt)$", "", text)
    return re.sub(r"^#+\s*", "", text)


def parse_outline(text, title=None):
    rows = []
    fence = None
    key = title_key(title)

    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if key:
        for i, line in enumerate(lines):
            if not line.strip():
                continue
            if re.match(r"^<!--@comment:.*-->\s*$", line.strip()):
                continue
            m = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
            if m and title_key(m.group(1)) == key:
                del lines[i]
            break

    for line in lines:
        if fence is not None:
            if not line.strip():
                rows[-1]["note"].append("")
                continue
            lead = len(line) - len(line.lstrip(" \t"))
            body = line[lead:]
            if lead < fence["cut"]:
                fence = None
            else:
                m = re.match(r"^(`{3,}|~{3,})[ \t]*$", body)
                if m and m.group(1)[0] == fence["ch"] and len(m.group(1)) >= fence["len"]:
                    rows[-1]["note"].append(line[fence["cut"]:])
                    fence = None
                    continue
                rows[-1]["note"].append(line[fence["cut"]:])
                continue

        if not line.strip():
            continue

        lead_raw = line[: len(line) - len(line.lstrip(" \t"))]
        body = line[len(lead_raw):]
        cols = sum(4 if ch == "\t" else 1 for ch in lead_raw)

        m = re.match(r"^(`{3,}|~{3,})(.*)$", body)
        if m and rows:
            fence = {"ch": m.group(1)[0], "len": len(m.group(1)), "cut": len(lead_raw)}
            rows[-1]["note"].append(body)
            continue

        q = re.match(r"^>( ?)(.*)$", body)
        if q and rows:
            rows[-1]["note"].append(q.group(2))
            continue
        if q:
            body = q.group(2)

        # 蓝图注释框：顶层整行的机器标注（<!--@comment:...-->），不是节点，
        # 不进大纲也不进指纹——AI 读文件时直接无视。
        if cols == 0 and re.match(r"^<!--@comment:.*-->\s*$", body):
            continue

        body = re.sub(r"^[-*+]\s+", "", body)
        body = re.sub(r"^\\(?=[-*+>])", "", body)
        pos = None
        pm = POS_RE.search(body)
        if pm:
            body = POS_RE.sub("", body)
            pos = (int(pm.group(1)), int(pm.group(2)))
        rows.append({"cols": cols, "text": body.strip(), "note": [], "pos": pos})

    root = {"text": "", "children": [], "note": "", "pos": None}
    if not rows:
        return root

    positives = [r["cols"] for r in rows if r["cols"] > 0]
    unit = 4
    if positives:
        unit = max(1, min(8, min(positives)))

    stack = []
    for row in rows:
        depth = row["cols"] // unit
        if depth > len(stack):
            depth = len(stack)
        del stack[depth:]

        node = {
            "text": row["text"],
            "children": [],
            "note": "\n".join(row["note"]).rstrip(),
            "pos": row["pos"] if depth == 0 else None,
        }
        if stack:
            stack[-1]["children"].append(node)
        else:
            root["children"].append(node)
        stack.append(node)

    if key and len(root["children"]) == 1:
        only = root["children"][0]
        if (not only["note"].strip() and only["children"]
                and title_key(only["text"]) == key):
            root["children"] = only["children"]

    return root


def walk_nodes(root):
    """先序遍历：(路径, 节点, 深度)。"""
    out = []

    def walk(node, path, depth):
        out.append((path, node, depth))
        for i, child in enumerate(node["children"], 1):
            walk(child, f"{path}.{i}", depth + 1)

    for i, child in enumerate(root["children"], 1):
        walk(child, str(i), 0)
    return out


def tree_hash(root):
    lines = [f"{depth}|{node['text'].strip()}" for _, node, depth in walk_nodes(root)]
    h = 2166136261
    for b in "\n".join(lines).encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return format(h, "08x")


# ---------------------------------------------------------------------- ops

def read_block(lines, start, line_no):
    """吃掉 << … >> 之间的原文，返回 (正文, 下一行下标)。"""
    body = []
    i = start
    while i < len(lines) and lines[i].strip() != ">>":
        body.append(lines[i])
        i += 1
    if i >= len(lines):
        raise ValueError(f"第 {line_no} 行的 << 没有对应的 >>")
    return "\n".join(body).rstrip(), i + 1


def parse_ops(text):
    """返回 (ops, groups)。group 是 {title, why, line, count}，op 里带 group 下标。"""
    lines = text.replace("\r\n", "\n").split("\n")
    ops = []
    groups = []
    current = None
    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.strip()
        i += 1
        if not line or line.startswith("#"):
            continue

        if line == "end":
            if current is None:
                raise ValueError(f"第 {i} 行：end 前面没有 begin")
            if not current["count"]:
                raise ValueError(f"第 {current['line']} 行的修改块里一条改动都没有")
            current = None
            continue

        m = BEGIN_RE.match(line)
        if m:
            if current is not None:
                raise ValueError(
                    f"第 {i} 行：修改块不能套修改块（第 {current['line']} 行那个还没 end）"
                )
            title = (m.group(1) or "").strip()
            if not title:
                raise ValueError(f"第 {i} 行：begin 后面要跟这个修改块的标题")
            groups.append({"title": title, "why": "", "line": i, "count": 0})
            current = groups[-1]
            continue

        m = WHY_RE.match(line)
        if m:
            if current is None:
                raise ValueError(f"第 {i} 行：why 只能写在 begin 和 end 之间")
            rest = (m.group(1) or "").strip()
            if rest == "<<":
                addition, i = read_block(lines, i, i)
                addition = addition.strip()
            else:
                addition = rest
            if not addition:
                raise ValueError(f"第 {i} 行：why 是空的")
            current["why"] = (current["why"] + "\n" + addition).strip() if current["why"] else addition
            continue

        m = OP_RE.match(line)
        if not m:
            raise ValueError(f"看不懂这一行：{raw.strip()}")

        kind, path, rest = m.group(1), m.group(2), m.group(3)
        if path != "-" and not re.fullmatch(r"\d+(\.\d+)*", path):
            raise ValueError(f"路径不对：{path}（应该像 2.3 这样，或者 - 表示顶层）")
        if path == "-" and kind != "add":
            raise ValueError(f"第 {i} 行：只有 add 能用 -（新增顶层）；{kind} 要写具体路径")

        op = {
            "kind": kind, "path": path, "text": "", "block": "",
            "parent": "", "line": i, "group": None,
        }
        if current is not None:
            op["group"] = len(groups) - 1

        if kind == "move":
            parent = rest.strip()
            if parent != "-" and not re.fullmatch(r"\d+(\.\d+)*", parent):
                raise ValueError(f"第 {op['line']} 行：move 后面跟新的父节点路径，或者 - 表示搬到顶层")
            op["parent"] = parent
            ops.append(op)
            if current is not None:
                current["count"] += 1
            continue

        if rest.strip() == "<<":
            op["block"], i = read_block(lines, i, op["line"])
        else:
            op["text"] = rest.rstrip()

        if kind in BLOCK_KINDS and not op["block"] and not op["text"]:
            raise ValueError(f"第 {op['line']} 行的 {kind} 没有内容")
        if kind == "rename" and not op["text"]:
            op["text"] = "未命名"
        ops.append(op)
        if current is not None:
            current["count"] += 1

    if current is not None:
        raise ValueError(f"第 {current['line']} 行的修改块没 end")
    return ops, groups


def resolve(root, path):
    if path == "-":
        return None
    node = None
    for part in path.split("."):
        idx = int(part) - 1
        children = root["children"] if node is None else node["children"]
        if idx < 0 or idx >= len(children):
            return None
        node = children[idx]
    return node


def holds(ancestor, node):
    """ancestor 这棵子树里有没有 node。"""
    if ancestor is node:
        return True
    return any(holds(child, node) for child in ancestor["children"])


def validate(root, ops):
    problems = []
    for op in ops:
        if op["path"] == "-":
            continue
        target = resolve(root, op["path"])
        if target is None:
            problems.append(f"第 {op['line']} 行：{op['path']} 这个节点不存在")
            continue
        if op["kind"] == "move":
            parent = root if op["parent"] == "-" else resolve(root, op["parent"])
            if parent is None:
                problems.append(f"第 {op['line']} 行：要搬到 {op['parent']}，但那个节点不存在")
                continue
            if holds(target, parent):
                problems.append(f"第 {op['line']} 行：不能把 {op['path']} 搬到它自己里面")
                continue
            # 目标父级被同一份提案删掉时，搬过去等于把节点扔进一个不在树上的
            # 容器里；drop 连子孙都带走，del 只带走这一层（子节点会升上来）。
            parent_conflict = False
            for other in ops:
                if other is op or other["kind"] not in ("del", "drop"):
                    continue
                victim = resolve(root, other["path"])
                if victim is None:
                    continue
                if other["kind"] == "drop" and holds(victim, parent):
                    problems.append(
                        f"第 {op['line']} 行：要搬到 {op['parent']}，但它在第 "
                        f"{other['line']} 行的 drop 范围里，冲突"
                    )
                    parent_conflict = True
                    break
                if other["kind"] == "del" and parent is victim:
                    problems.append(
                        f"第 {op['line']} 行：要搬到 {op['parent']}，但它在第 "
                        f"{other['line']} 行的 del 里，冲突"
                    )
                    parent_conflict = True
                    break
            if parent_conflict:
                continue
        for other in ops:
            if other is op or other["kind"] not in ("del", "drop"):
                continue
            victim = resolve(root, other["path"])
            if victim is None:
                continue
            # `drop` 是一整片拿走，里面就别再动了；`del` 只拿走这一层，
            # 子节点会升上来，所以对子节点的 rename/note 是合法的。
            if other["kind"] == "drop" and (
                (victim is target and op["kind"] != "drop")
                or (target is not victim and holds(victim, target))
            ):
                problems.append(
                    f"第 {op['line']} 行：{op['path']} 在 {other['path']} 的删除范围里，冲突"
                )
                break
            if victim is target and other["kind"] == "del" and op["kind"] != "del":
                problems.append(
                    f"第 {op['line']} 行：{op['path']} 又被第 {other['line']} 行删掉了，冲突"
                )
                break
    return problems


# -------------------------------------------------------------------- write

def index_path():
    return PROPOSAL_DIR / "index.txt"


def update_index(name, doc_name, present):
    """proposals/index.txt：一行「文件名<TAB>文档名」，页面只看这份清单。"""
    PROPOSAL_DIR.mkdir(parents=True, exist_ok=True)
    path = index_path()
    rows = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            if line.split("\t")[0] == name:
                continue
            rows.append(line)
    if present:
        rows.append(name + "\t" + doc_name)
    body = "\n".join(rows)
    path.write_text((body + "\n") if rows else "", encoding="utf-8", newline="\n")
    rebuild_pending()


def rebuild_pending():
    """双击打开的页面是 file://，fetch 被禁；<script> 还读得到。

    所以把待审批的提案镜像成一份 pending.js：页面加载它就知道有什么在等。
    写成纯 ASCII 的 JSON，任何编码下都不会坏。
    """
    PROPOSAL_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    path = index_path()
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split("\t")
            if len(parts) < 2:
                continue
            name, doc = parts[0], parts[1]
            probe = PROPOSAL_DIR / name
            if not probe.exists():
                continue
            rows.append({
                "file": name,
                "doc": doc,
                "text": probe.read_text(encoding="utf-8-sig"),
            })
    body = json.dumps(rows, ensure_ascii=True)
    (PROPOSAL_DIR / "pending.js").write_text(
        "window.__MIND_PROPOSALS__ = " + body + ";\n",
        encoding="utf-8",
        newline="\n",
    )


def proposal_path(doc, sibling=False):
    if sibling:
        return doc.with_name(doc.name + ".proposal")
    return PROPOSAL_DIR / (doc.stem + ".proposal")


def read(path):
    return Path(path).read_text(encoding="utf-8-sig")


def cmd_tree(doc):
    root = parse_outline(read(doc), doc.stem)
    width = max((len(p) for p, _, _ in walk_nodes(root)), default=1)
    for path, node, _ in walk_nodes(root):
        text = node["text"] or "未命名"
        extra = ""
        if node["note"].strip():
            extra = f"    [备注 {len([l for l in node['note'].split(chr(10)) if l.strip()])} 行]"
        print(f"{path.ljust(width)}  {text}{extra}")
    print()
    print(f"# {len(walk_nodes(root))} 个节点 · 指纹 {tree_hash(root)}")


def op_line(op):
    if op["block"]:
        return [f"{op['kind']} {op['path']} <<"] + op["block"].split("\n") + [">>"]
    if op["kind"] in ("del", "drop"):
        return [f"{op['kind']} {op['path']}"]
    if op["kind"] == "move":
        return [f"move {op['path']} {op['parent']}"]
    return [f"{op['kind']} {op['path']} {op['text']}".rstrip()]


def cmd_write(doc, ops_path, sibling=False):
    root = parse_outline(read(doc), doc.stem)
    ops, groups = parse_ops(read(ops_path) if ops_path != "-" else sys.stdin.read())
    if not ops:
        raise ValueError("操作清单是空的")

    problems = validate(root, ops)
    if problems:
        print("校验没过：", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1

    out = [f"→ {doc.name}", f"~ {tree_hash(root)}"]
    open_group = None
    for op in ops:
        if op["group"] != open_group:
            if open_group is not None:
                out.append("end")
            open_group = op["group"]
            if open_group is not None:
                group = groups[open_group]
                out.append("begin " + group["title"])
                if group["why"]:
                    why = group["why"].split("\n")
                    if len(why) == 1:
                        out.append("why " + why[0])
                    else:
                        out.append("why <<")
                        out.extend(why)
                        out.append(">>")
        out.extend(op_line(op))
    if open_group is not None:
        out.append("end")

    target = proposal_path(doc, sibling)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
    # 同目录提案由页面通过文件夹句柄直接找，不进 proposals/ 清单——否则
    # 清单会指向 proposals/ 里一个并不存在的文件。
    if not sibling:
        update_index(target.name, doc.stem, True)

    print(f"提案已写好：{target}")
    print(f"  {len(ops)} 项改动 · {len(groups)} 个修改块")
    for op in ops:
        label = resolve(root, op["path"])["text"] if op["path"] != "-" else "（新顶层）"
        mark = f"[{groups[op['group']]['title']}] " if op["group"] is not None else ""
        print(f"  {op['kind']:<6} {op['path']:<6} {mark}{label}".rstrip())
    print()
    if sibling:
        print("打开这份 .md 的产品定义窗口，点右上角的「待审批」。")
    else:
        print(f"Toolset 开在 127.0.0.1:8770 时，打开「{doc.stem}」就会亮起待审批。")
    return 0


def cmd_check(doc, ops_path):
    root = parse_outline(read(doc), doc.stem)
    ops, groups = parse_ops(read(ops_path) if ops_path != "-" else sys.stdin.read())
    problems = validate(root, ops)
    for p in problems:
        print("  " + p, file=sys.stderr)
    if problems:
        return 1
    blocks = f"，{len(groups)} 个修改块" if groups else ""
    print(f"{len(ops)} 条操作{blocks}都能对上，指纹 {tree_hash(root)}")
    return 0


def cmd_clean(doc):
    target = proposal_path(doc)
    removed = []
    for path in (target, proposal_path(doc, sibling=True)):
        update_index(path.name, doc.stem, False)
        if path.exists():
            path.unlink()
            removed.append(path)
    print("已清掉：" + "，".join(str(p) for p in removed) if removed else "没有待审批的提案")
    return 0


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
        print("\n用法：propose.py tree|write|check|clean <文件.md> [操作清单]", file=sys.stderr)
        return 2

    cmd, doc = argv[1], Path(argv[2])
    if not doc.exists():
        print(f"找不到 {doc}", file=sys.stderr)
        return 2
    if doc.suffix.lower() not in (".md", ".markdown", ".txt", ".mind"):
        print(f"{doc} 看起来不是大纲文件", file=sys.stderr)
        return 2

    sibling = "--sibling" in argv
    rest = [a for a in argv[3:] if not a.startswith("--")]

    try:
        if cmd == "tree":
            cmd_tree(doc)
            return 0
        if cmd == "write":
            if not rest:
                print("write 还需要一份操作清单", file=sys.stderr)
                return 2
            return cmd_write(doc, rest[0], sibling)
        if cmd == "check":
            if not rest:
                print("check 还需要一份操作清单", file=sys.stderr)
                return 2
            return cmd_check(doc, rest[0])
        if cmd == "clean":
            return cmd_clean(doc)
    except ValueError as err:
        print(str(err), file=sys.stderr)
        return 1

    print(f"不认识这个命令：{cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
