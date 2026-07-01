"""配置文件与保存目录（root）解析。

保存目录优先级：--root 显式 > ~/.config/ai-log/config.json > 兜底 ~/.cache/ai-log。
~/.config 与 ~/.cache 分别尊重 XDG_CONFIG_HOME / XDG_CACHE_HOME 环境变量。
"""
import json
import os


def config_dir():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "ai-log")


def config_path():
    return os.path.join(config_dir(), "config.json")


def cache_root():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "ai-log")


def load_config():
    p = config_path()
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_config(cfg):
    os.makedirs(config_dir(), exist_ok=True)
    with open(config_path(), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def resolve_root(cli_root):
    if cli_root:
        return os.path.abspath(os.path.expanduser(cli_root)), "explicit"
    cfg = load_config()
    if cfg.get("root"):
        return os.path.abspath(os.path.expanduser(cfg["root"])), "config"
    return cache_root(), "cache"
