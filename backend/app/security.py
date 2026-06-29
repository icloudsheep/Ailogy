"""安全工具：密码哈希（argon2）、会话/分享 token、API 密钥生成与校验。

密钥只存 sha256 哈希 + 明文前缀，明文仅创建时返回一次。密码用 argon2id。
"""
import hashlib
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError

_ph = PasswordHasher()  # argon2id 默认参数，适配本地自托管规模


# ── 密码 ──
def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    try:
        return _ph.verify(stored_hash, password)
    except (VerifyMismatchError, InvalidHashError, Exception):
        return False


# ── 随机 token（会话、分享）──
def new_token(nbytes: int = 32) -> str:
    """URL 安全的随机 token，用于会话 id 与分享 token。"""
    return secrets.token_urlsafe(nbytes)


# ── API 密钥 ──
_KEY_PREFIX = "ak_"


def new_api_key():
    """生成新 API 密钥，返回 (明文, 前缀, sha256哈希)。

    明文形如 ak_xxxx...，仅创建时返回给用户一次；库里只存 prefix(展示用) + hash(校验用)。
    """
    secret = secrets.token_urlsafe(32)
    plain = _KEY_PREFIX + secret
    prefix = plain[:11]  # ak_ + 8 字符，列表里辨认用
    return plain, prefix, hash_api_key(plain)


def hash_api_key(plain: str) -> str:
    """对完整密钥取 sha256（鉴权时用入参算 hash 再比对，库里不存明文）。"""
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()
