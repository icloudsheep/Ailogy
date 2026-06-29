"""argparse 参数解析与命令分发（main 入口）。

用法:
    # 记录一条日志（root 解析顺序见下）
    python3 ai_logger.py --summary "<总结正文>" [--title "<标题, ≤30字>"] [--id "<可选会话名>"] [--root <本次保存目录>]

    # 永久指定保存目录（写入配置后退出；可同时带 --summary 立即记一条）
    python3 ai_logger.py --set-root <目录> [--summary "..."]

    # 查询当前配置状态（输出 JSON，供调用方判断是否需要询问用户），不写日志
    python3 ai_logger.py --status

    # 永久重命名会话：写 <root>/aliases.json 并刷新 aliases.js（传空名清除）
    python3 ai_logger.py --rename "Fox-3f2a" "重构专项"

    # 永久编辑 / 删除某条日志（按 日期 + seq 定位），重渲染该日 HTML
    python3 ai_logger.py --edit "2026-06-24" 3 --title "新标题" --summary "..."
    python3 ai_logger.py --delete "2026-06-24" 3

    # 把当前模板重铺到所有历史日期页面（模板升级后用），并刷新资产软链
    python3 ai_logger.py --rerender

保存目录（root）解析顺序:
    1. --root 显式指定（仅本次生效，不落盘为永久配置）
    2. 配置文件 ~/.config/ai-log/config.json 中的 "root"（永久，由 --set-root 写入）
    3. 兜底 ~/.cache/ai-log（临时位置；此时 --status 报告 configured=false）
    （~/.config 与 ~/.cache 分别尊重 XDG_CONFIG_HOME / XDG_CACHE_HOME 环境变量）
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
    parser.add_argument("--title", default=None,
                        help="本条日志标题（建议 ≤30 字），在网页详情面板顶部单独展示")
    parser.add_argument("--id", default=None, help="可选，手动覆盖会话代号 name")
    parser.add_argument("--mode", default=None, choices=["full"],
                        help="记录模式：full=按主题总结的条目（时间线节点加 🚀 角标）")
    parser.add_argument("--root", default=None, help="本次保存目录（仅当次生效，不落盘）")
    parser.add_argument("--set-root", default=None, dest="set_root",
                        help="永久指定保存目录，写入 ~/.config/ai-log/config.json")
    parser.add_argument("--status", action="store_true",
                        help="输出当前 root 配置状态（JSON）后退出，不写日志")
    parser.add_argument("--rename", nargs=2, metavar=("会话ID", "自定义名"),
                        default=None,
                        help="把会话 ID（如 Fox-3f2a）永久重命名为自定义名，写入"
                             " <root>/aliases.json 并重渲染所有日期 HTML；传空名清除别名")
    parser.add_argument("--edit", nargs=2, metavar=("日期", "序号"), default=None,
                        help="永久编辑某条日志：定位 <root>/{日期}/data.json 中 seq=序号 的条目，"
                             "配合 --title / --summary 改写标题或正文后重渲染该日 HTML")
    parser.add_argument("--delete", nargs=2, metavar=("日期", "序号"), default=None,
                        help="永久删除某条日志：从 <root>/{日期}/data.json 移除 seq=序号 的条目"
                             "并重渲染该日 HTML（其余条目 seq 不变）")
    parser.add_argument("--rerender", action="store_true",
                        help="把当前模板重新铺到 <root> 下所有日期的 index.html（模板升级后用），"
                             "并刷新 version.js / mermaid / katex 软链；不改 data.json")
    args = parser.parse_args()

    # --status：仅报告，不写日志。供调用方判断是否需要询问用户永久位置。
    if args.status:
        root, source = resolve_root(None)
        print(json.dumps({
            "configured": source == "config",   # 是否已永久指定
            "source": source,                    # config / cache（status 下不会是 explicit）
            "root": root,
            "config_path": config_path(),
        }, ensure_ascii=False))
        return

    # --rename：固化会话别名到 aliases.json 并刷新 aliases.js（所有日期页面刷新即生效，无需重渲染）。
    if args.rename is not None:
        root, _src = resolve_root(args.root)
        cid, alias = args.rename[0].strip(), args.rename[1].strip()
        save_alias(root, cid, alias)
        verb = f"重命名为「{alias}」" if alias else "清除别名"
        print(f"🏷️ 会话 {cid} 已{verb} -> {aliases_js_path(root)}（刷新页面即生效）")
        return

    # --edit：永久改写某条日志的标题/正文（按 date + seq 定位），重渲染该日 HTML。
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

    # --delete：永久删除某条日志（按 date + seq 定位），重渲染该日 HTML。
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

    # --rerender：模板升级后，把新模板铺到所有历史日期页面，并刷新 root 根软链（含 katex）。
    if args.rerender:
        root, _src = resolve_root(args.root)
        link_skill_assets(root)   # 即便没有任何日期目录，也先建好 version/mermaid/katex 软链
        n = rerender_all_days(root)
        print(f"♻️ 已用当前模板重渲染 {n} 个日期页面 -> {root}（刷新页面即生效）")
        return

    # --set-root：把永久目录写入配置；后续若带 --summary 则用该目录立即记一条。
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

    # 解析本次保存目录：--root / --set-root > config > cache 兜底
    root, source = resolve_root(args.root or chosen_root)
    cn, codename_id, html_path = write_entry(root, args.summary, args.title, args.id, args.mode)

    print(f"✅ 日志已保存（{cn['emoji']} {codename_id}）-> {html_path}")
    if source == "cache":
        # 用了临时兜底目录，提示调用方下次仍可询问用户是否永久指定
        print(f"ℹ️ 当前为临时位置（未永久指定）：{root}", file=sys.stderr)


if __name__ == "__main__":
    main()
