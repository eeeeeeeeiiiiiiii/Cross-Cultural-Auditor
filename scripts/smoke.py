"""冒烟测试：不动浏览器，直接打一遍 /api/audit。

用法：
    python scripts/smoke.py                 # 走 AI 翻译路径
    python scripts/smoke.py --provided      # 走「用户自带译文」路径
    python scripts/smoke.py "你的中文文案"
"""

import json
import os
import sys
import time
from pathlib import Path

import httpx

BASE = os.environ.get("BASE", "http://localhost:3000")
ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "public" / "fixtures" / "demo.json"

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
PROVIDED = "--provided" in sys.argv
SOURCE = (
    ARGS[0]
    if ARGS
    else "我们的面膜采用天然草本精华，一抹即白，让您爱不释手。女神节送礼首选！"
)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    started = time.time()
    counts = {}

    def handle(event, data):
        counts[event] = counts.get(event, 0) + 1

        if event == "meta":
            print(f"[meta] mock={data.get('mock')} model={data.get('model')} markets={','.join(data.get('markets', []))}")

        elif event == "translation.done":
            text = data.get("text", "")
            origin = "用户提供" if data.get("source") == "user" else "AI 翻译"
            print(f"\n[{data['market']}] 译文（{origin}）：\n  {text[:160]}{'…' if len(text) > 160 else ''}")

        elif event == "audit.result":
            d = data["distribution"]
            print(
                f"\n[{data['market']}] {data['score']} 分 · {data['level']} · "
                f"P0×{d['P0']} P1×{d['P1']} P2×{d['P2']}"
            )
            for f in data.get("findings", []):
                suggestion = (f.get("suggestions") or [{}])[0].get("text", "")
                print(f"   {f['severity']} {f['category']:<10} {f['targetQuote'][:46]}")
                print(f"        -> {suggestion}")
            if not data.get("findings") and data.get("dropped"):
                print(f"   ! {data['dropped']} 条建议未能定位到译文，已丢弃")

        elif event in ("translation.error", "audit.error", "error"):
            print(f"\n[{event}] {data.get('message')}", file=sys.stderr)

    payload = {
        "source": SOURCE,
        "markets": ["us", "mena", "sea"],
        "tone": "professional",
        "strictness": "standard",
    }

    if PROVIDED:
        fixtures = json.loads(FIXTURE.read_text(encoding="utf-8"))["markets"]
        payload["translations"] = {mid: fixtures[mid]["translation"] for mid in payload["markets"]}
        print("[mode] 用户自带译文：不发翻译请求，直接审")
    else:
        print("[mode] AI 翻译路径：译文由模型生成")

    with httpx.stream("POST", f"{BASE}/api/audit", json=payload, timeout=120) as resp:
        if resp.status_code != 200:
            print("HTTP", resp.status_code, resp.read().decode("utf-8", "ignore"))
            return 1

        event = None
        data_lines = []

        for line in resp.iter_lines():
            if line == "":
                if data_lines:
                    raw = "\n".join(data_lines)
                    try:
                        handle(event, json.loads(raw))
                    except json.JSONDecodeError:
                        pass
                event, data_lines = None, []
                continue

            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())

    print(f"\n事件统计：{json.dumps(counts, ensure_ascii=False)}")
    print(f"耗时 {int((time.time() - started) * 1000)} ms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
