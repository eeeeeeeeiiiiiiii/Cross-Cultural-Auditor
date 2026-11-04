"""手写校验 —— 不引入额外依赖。

原则：能救的救（截断、裁剪、降级），救不了的丢，绝不因为一条脏数据整屏报错。
"""

import json
import re

CATEGORIES = [
    "skin_race",
    "religion",
    "gender",
    "inclusive",
    "legal",
    "symbol",
    "tone",
    "literal",
]

SEVERITIES = ["P0", "P1", "P2", "P3"]
TONES = ["premium", "friendly", "professional"]
STRICTNESS = ["loose", "standard", "strict"]

MAX_SOURCE = 1200
MAX_TRANSLATION = 2000
MAX_FINDINGS = 6


def _is_str(v):
    return isinstance(v, str) and v.strip() != ""


def _clamp01(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, n))


def parse_json_loose(text: str):
    """从可能带 ```json 包裹的文本里抠出 JSON 对象。"""
    if not isinstance(text, str) or not text.strip():
        return None

    s = text.strip()

    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, re.IGNORECASE)
    if fence:
        s = fence.group(1).strip()

    try:
        return json.loads(s)
    except Exception:
        pass

    start, end = s.find("{"), s.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(s[start : end + 1])
        except Exception:
            return None
    return None


def sanitize_audit(raw, translation: str = "", min_conf: float = 0.0):
    """校验并清洗模型的审查结果。

    返回 {"summary": str, "findings": [...], "dropped": int}
    """
    out = {"summary": "", "findings": [], "dropped": 0}
    if not isinstance(raw, dict):
        return out

    if _is_str(raw.get("summary")):
        out["summary"] = raw["summary"].strip()[:60]

    items = raw.get("findings")
    if not isinstance(items, list):
        return out

    seen = set()

    for f in items:
        if not isinstance(f, dict):
            out["dropped"] += 1
            continue

        category = f.get("category") if f.get("category") in CATEGORIES else None
        severity = f.get("severity") if f.get("severity") in SEVERITIES else None
        target_quote = f.get("targetQuote").strip() if _is_str(f.get("targetQuote")) else ""
        source_quote = f.get("sourceQuote").strip() if _is_str(f.get("sourceQuote")) else ""
        issue = f.get("issue").strip() if _is_str(f.get("issue")) else ""
        why = f.get("why").strip() if _is_str(f.get("why")) else ""
        confidence = _clamp01(f.get("confidence"))

        if not (category and severity and target_quote and issue):
            out["dropped"] += 1
            continue

        # 定位不到的条目直接丢弃：留着也没法高亮、没法替换
        if translation and target_quote not in translation:
            out["dropped"] += 1
            continue

        if confidence < min_conf:
            out["dropped"] += 1
            continue

        raw_suggestions = f.get("suggestions")
        suggestions = []
        if isinstance(raw_suggestions, list):
            for s in raw_suggestions[:3]:
                if isinstance(s, dict) and _is_str(s.get("text")):
                    suggestions.append(
                        {
                            "text": s["text"].strip(),
                            "note": s["note"].strip() if _is_str(s.get("note")) else "",
                        }
                    )

        if not suggestions:
            out["dropped"] += 1
            continue

        usable = [s for s in suggestions if s["text"] != target_quote]

        key = (category, target_quote)
        if key in seen:
            out["dropped"] += 1
            continue
        seen.add(key)

        out["findings"].append(
            {
                "category": category,
                "severity": severity,
                "sourceQuote": source_quote,
                "targetQuote": target_quote,
                "issue": issue[:80],
                "why": why[:400],
                "suggestions": usable if usable else suggestions,
                "confidence": confidence,
            }
        )

    rank = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    out["findings"].sort(key=lambda x: (rank[x["severity"]], -x["confidence"]))

    if len(out["findings"]) > MAX_FINDINGS:
        out["dropped"] += len(out["findings"]) - MAX_FINDINGS
        out["findings"] = out["findings"][:MAX_FINDINGS]

    for i, f in enumerate(out["findings"]):
        f["id"] = f"f{i}"

    return out


def parse_llm_block(raw):
    """校验前端传来的模型配置。返回 (cfg, error)。"""
    if not isinstance(raw, dict):
        return None, "缺少模型配置"

    base = str(raw.get("baseUrl") or "").strip().rstrip("/")
    key = str(raw.get("apiKey") or "").strip()
    model = str(raw.get("model") or "").strip()

    if not key:
        return None, "请填写 API 密钥"
    if not base.startswith(("http://", "https://")):
        return None, "接口地址必须以 http:// 或 https:// 开头"
    if not model:
        return None, "请填写模型名"
    if len(key) > 400:
        return None, "密钥长度异常"

    return {"baseUrl": base, "apiKey": key, "model": model}, None


def clean_tone(raw) -> str:
    """语气既可以是预设值，也可以是用户自己写的一句话。

    自定义文本会进 system prompt，所以压掉换行、限制长度，避免把 prompt 结构拆坏。
    """
    if not isinstance(raw, str):
        return "professional"
    text = " ".join(raw.split())[:40].strip()
    return text or "professional"


def parse_request(body):
    """校验请求体，返回 (ok, value, error)。"""
    if not isinstance(body, dict):
        return False, None, "请求体不是合法 JSON"

    source = body.get("source").strip() if isinstance(body.get("source"), str) else ""
    if len(source) < 4:
        return False, None, "文案太短了，至少 4 个字"
    if len(source) > MAX_SOURCE:
        return False, None, f"文案最多 {MAX_SOURCE} 字，当前 {len(source)} 字"

    markets = body.get("markets")
    markets = list(dict.fromkeys(m for m in markets if isinstance(m, str)))[:3] if isinstance(markets, list) else []
    if not markets:
        return False, None, "至少选择一个市场"

    tone = clean_tone(body.get("tone"))
    strictness = body.get("strictness") if body.get("strictness") in STRICTNESS else "standard"

    # 用户自带的译文：{market_id: text}。留空的市场走 AI 翻译。
    translations = {}
    raw_translations = body.get("translations")
    if isinstance(raw_translations, dict):
        for key, value in raw_translations.items():
            if isinstance(key, str) and isinstance(value, str) and value.strip():
                translations[key] = value.strip()[:MAX_TRANSLATION]

    # 前端页面里填的模型配置（可选）；不填就用服务端 .env
    llm_cfg = None
    raw_llm = body.get("llm")
    if isinstance(raw_llm, dict) and str(raw_llm.get("apiKey") or "").strip():
        llm_cfg, llm_err = parse_llm_block(raw_llm)
        if llm_err:
            return False, None, llm_err

    return (
        True,
        {
            "source": source,
            "markets": markets,
            "tone": tone,
            "strictness": strictness,
            "translations": translations,
            "llm": llm_cfg,
        },
        None,
    )
