"""会话代号确定性派生。

由 CLAUDE_CODE_SESSION_ID 的 SHA1 哈希取模选动物 + 取后缀，
保证「同会话恒得同代号、不同会话彼此独立」。
"""
import hashlib

# 动物代号表：哈希取模选一项，保证「同会话同代号、规律可读」。可自由扩充。
ANIMALS = [
    ("🦊", "Fox"), ("🐺", "Wolf"), ("🦅", "Eagle"), ("🦉", "Owl"),
    ("🐬", "Dolphin"), ("🦌", "Deer"), ("🐯", "Tiger"), ("🐼", "Panda"),
    ("🦁", "Lion"), ("🐢", "Turtle"), ("🦫", "Beaver"), ("🦦", "Otter"),
    ("🐙", "Octopus"), ("🦋", "Butterfly"), ("🐝", "Bee"), ("🦜", "Parrot"),
    ("🐉", "Dragon"), ("🦓", "Zebra"), ("🦒", "Giraffe"), ("🐘", "Elephant"),
    ("🦏", "Rhino"), ("🐳", "Whale"), ("🦭", "Seal"), ("🦔", "Hedgehog"),
    ("🐿️", "Squirrel"), ("🦇", "Bat"), ("🐊", "Croc"), ("🦚", "Peacock"),
    ("🐧", "Penguin"), ("🦩", "Flamingo"),
]


def session_codename(seed):
    """由会话种子确定性派生代号：emoji + 动物名 + 4位十六进制后缀。

    同一 seed 永远得到同一结果，不同 seed 几乎不重复；
    seed 为空（无会话环境变量）时退化为固定占位代号。
    """
    if not seed:
        return {"emoji": "🐾", "name": "Anon", "suffix": "0000"}
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    emoji, name = ANIMALS[int(digest[:8], 16) % len(ANIMALS)]
    return {"emoji": emoji, "name": name, "suffix": digest[8:12]}
