"""argparse 参数解析与命令分发（main 入口）。

用法:
    # 记录一条日志
    python3 ai_logger.py --summary "<总结正文>" [--title "<标题>"] [--id "<可选会话名>"] [--root <本次保存目录>]

    # 永久指定保存目录
    python3 ai_logger.py --set-root <目录> [--summary "..."]

    # 查询当前配置状态（输出 JSON）
    python3 ai_logger.py --status

    # 重命名会话
    python3 ai_logger.py --rename "Fox-3f2a" "重构专项"

    # 编辑 / 删除
    python3 ai_logger.py --edit "2026-06-24" 3 --title "新标题" --summary "..."
    python3 ai_logger.py --delete "2026-06-24" 3

    # 重渲染所有历史日期页面
    python3 ai_logger.py --rerender
"""
import argparse
import json
import os
import sys

from .config import config_path, load_config, resolve_root, save_config
from .entry import write_entry, edit_entry, delete_entry
from .render import save_alias, aliases_js_path, link_skill_assets, rerender_all_days


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--summary", default=None)
    parser.add_argument("--title", default=None)
    parser.add_argument("--id", default=None, help="可选，手动覆盖会话代号 name")
    parser.add_argument("--mode", default=None, choices=["full"])
    parser.add_argument("--root", default=None, help="本次保存目录（仅当次生效，不落盘）")
    parser.add_argument("--set-root", default=None, dest="set_root")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--rename", nargs=2, metavar=("会话ID", "自定义名"), default=None)
    parser.add_argument("--edit", nargs=2, metavar=("日期", "序号"), default=None)
    parser.add_argument("--delete", nargs=2, metavar=("日期", "序号"), default=None)
    parser.add_argument("--rerender", action="store_true")
    args = parser.parse_args()

    if args.status:
        root, source = resolve_root(None)
        print(json.dumps({
            "configured": source == "config",
            "source": source,
            "root": root,
            "config_path": config_path(),
        }, ensure_ascii=False))
        return

    if args.rename is not None:
        root, _src = resolve_root(args.root)
        cid, alias = args.rename[0].strip(), args.rename[1].strip()
        save_alias(root, cid, alias)
        verb = f"重命名为「{alias}」" if alias else "清除别名"
        print(f"🏷️ 会话 {cid} 已{verb} -> {aliases_js_path(root)}（刷新页面即生效）")
        return

    if args.edit is not None:
        root, _src = resolve_root(args.root)
        date_str, seq_raw = args.edit[0].strip(), args.edit[1].strip()
        try:
            seq = int(seq_raw)
        except ValueError:
            parser.error(f"--edit 序号须为整数，收到：{seq_raw}")
        if args.title is None and args.summary is None:
            parser.error("--edit 需配合 --title 或 --summary 指定要改写的内容")
        ok = edit_entry(root, date_str, seq, args.title, args.summary)
        if ok:
            print(f"✏️ 已编辑 {date_str} #{seq} -> {os.path.join(root, date_str, 'index.html')}（刷新页面即生效）")
        else:
            print(f"⚠️ 未找到 {date_str} #{seq} 对应的日志条目", file=sys.stderr)
            sys.exit(1)
        return

    if args.delete is not None:
        root, _src = resolve_root(args.root)
        date_str, seq_raw = args.delete[0].strip(), args.delete[1].strip()
        try:
            seq = int(seq_raw)
        except ValueError:
            parser.error(f"--delete 序号须为整数，收到：{seq_raw}")
        ok = delete_entry(root, date_str, seq)
        if ok:
            print(f"🗑️ 已删除 {date_str} #{seq} -> {os.path.join(root, date_str, 'index.html')}（刷新页面即生效）")
        else:
            print(f"⚠️ 未找到 {date_str} #{seq} 对应的日志条目", file=sys.stderr)
            sys.exit(1)
        return

    if args.rerender:
        root, _src = resolve_root(args.root)
        link_skill_assets(root)
        n = rerender_all_days(root)
        print(f"♻️ 已用当前模板重渲染 {n} 个日期页面 -> {root}")
        return

    chosen_root = None
    if args.set_root:
        chosen_root = os.path.abspath(os.path.expanduser(args.set_root))
        cfg = load_config()
        cfg["root"] = chosen_root
        save_config(cfg)
        print(f"📌 已永久指定日志保存目录：{chosen_root}")
        if args.summary is None:
            return

    if args.summary is None:
        parser.error("缺少 --summary（除非使用 --status 或仅 --set-root）")

    root, source = resolve_root(args.root or chosen_root)
    cn, codename_id, html_path, entry = write_entry(root, args.summary, args.title, args.id, args.mode)

    print(f"✅ 日志已保存（{cn['emoji']} {codename_id}）-> {html_path}")
    if source == "cache":
        print(f"ℹ️ 当前为临时位置（未永久指定）：{root}", file=sys.stderr)


if __name__ == "__main__":
    main()
