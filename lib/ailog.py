"""AI 调用日志 —— 只保留最近 N 次，方便人工核查。

存在 logs/ai.jsonl，一行一条 JSON。超过上限自动裁掉最旧的。
任何异常都吞掉：日志坏了也绝不能影响主流程。

环境变量：
    AI_LOG_LIMIT   保留条数，默认 200
    AI_LOG_ENABLED 置 0 可完全关闭
"""

import json
import os
import threading
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = ROOT / "logs"
LOG_FILE = LOG_DIR / "ai.jsonl"

MAX_FIELD = 12000  # 单字段硬上限，防止一次超长 prompt 把文件撑爆

_lock = threading.Lock()


def limit() -> int:
    try:
        return max(1, int(os.environ.get("AI_LOG_LIMIT") or 200))
    except ValueError:
        return 200


def enabled() -> bool:
    return os.environ.get("AI_LOG_ENABLED", "1").lower() not in ("0", "false", "off", "no")


def _clip(text) -> str:
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    return text if len(text) <= MAX_FIELD else text[:MAX_FIELD] + f"\n…（已截断，原长 {len(text)} 字）"


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _trim() -> None:
    """行数超上限就把文件重写成最后 N 条——保证"永远只有最近 N 次"。"""
    cap = limit()
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    if len(lines) <= cap:
        return

    tmp = LOG_FILE.with_name(LOG_FILE.name + ".tmp")
    tmp.write_text("\n".join(lines[-cap:]) + "\n", encoding="utf-8")
    tmp.replace(LOG_FILE)


def record(
    *,
    purpose: str,
    model: str = "",
    endpoint: str = "",
    market: str = "",
    request: dict | None = None,
    response: str = "",
    error: str | None = None,
    ms: int = 0,
    usage: dict | None = None,
) -> None:
    """写一条记录。永不抛异常。"""
    if not enabled():
        return

    entry = {
        "ts": _now(),
        "purpose": purpose,
        "market": market,
        "model": model,
        "endpoint": endpoint,
        "ok": error is None,
        "ms": ms,
        "request": {
            "system": _clip((request or {}).get("system", "")),
            "user": _clip((request or {}).get("user", "")),
        },
        "response": _clip(response),
        "error": _clip(error) if error else None,
        "usage": usage or None,
    }

    try:
        with _lock:
            LOG_DIR.mkdir(exist_ok=True)
            with LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            _trim()
    except Exception:
        # 磁盘满、权限不足……都不该影响这次请求
        pass


def read_all() -> list[dict]:
    """读全部记录（新的在后）。"""
    try:
        lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def clear() -> None:
    try:
        LOG_FILE.unlink(missing_ok=True)
    except Exception:
        pass
