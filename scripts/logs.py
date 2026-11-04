"""查看 AI 调用日志。

用法：
    python scripts/logs.py                # 最近 10 条摘要
    python scripts/logs.py -n 30          # 最近 30 条
    python scripts/logs.py --errors       # 只看失败的
    python scripts/logs.py -s mena        # 只看中东市场
    python scripts/logs.py -i 3           # 展开第 3 条（含完整 prompt 与返回）
    python scripts/logs.py --clear        # 清空日志
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lib import ailog  # noqa: E402


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="查看最近的 AI 调用日志")
    ap.add_argument("-n", "--last", type=int, default=10, help="显示最近几条，默认 10")
    ap.add_argument("--errors", action="store_true", help="只看失败的")
    ap.add_argument("-s", "--market", default="", help="按市场过滤：us / mena / sea")
    ap.add_argument("-p", "--purpose", default="", help="按用途过滤：translate / audit / ping / models")
    ap.add_argument("-i", "--index", type=int, default=0, help="展开第 N 条（从 1 开始，按列表顺序）")
    ap.add_argument("--clear", action="store_true", help="清空日志文件")
    args = ap.parse_args()

    if args.clear:
        ailog.clear()
        print("已清空。")
        return 0

    rows = ailog.read_all()
    if not rows:
        print(f"还没有记录。日志会在调用模型时自动写入：{ailog.LOG_FILE}")
        return 0

    if args.errors:
        rows = [r for r in rows if not r.get("ok")]
    if args.market:
        rows = [r for r in rows if r.get("market") == args.market]
    if args.purpose:
        rows = [r for r in rows if r.get("purpose") == args.purpose]

    if not rows:
        print("没有符合条件的记录。")
        return 0

    if args.index:
        if not 1 <= args.index <= len(rows):
            print(f"序号超出范围（共 {len(rows)} 条）")
            return 1
        return show_full(rows[args.index - 1], args.index)

    subset = rows[-args.last :]
    print(f"共 {len(rows)} 条记录（上限 {ailog.limit()}），显示最近 {len(subset)} 条：\n")
    start_index = len(rows) - len(subset) + 1
    for i, r in enumerate(subset, start=start_index):
        flag = "OK " if r.get("ok") else "ERR"
        market = (r.get("market") or "-").ljust(5)
        purpose = (r.get("purpose") or "-").ljust(9)
        model = (r.get("model") or "-")[:22].ljust(22)
        ts = (r.get("ts") or "")[11:19]
        print(f"  [{i:>3}] {ts}  {flag}  {purpose} {market} {model} {r.get('ms', 0):>6}ms")
        if not r.get("ok"):
            print(f"        ↳ {(r.get('error') or '').splitlines()[0][:100]}")

    print(f"\n展开某条看完整内容：python scripts/logs.py -i {len(rows)}")
    return 0


def show_full(row: dict, index: int) -> int:
    print("=" * 72)
    print(f"#{index}  {row.get('ts')}  {row.get('purpose')}  market={row.get('market') or '-'}")
    print(f"model={row.get('model')}  endpoint={row.get('endpoint')}")
    print(f"ok={row.get('ok')}  {row.get('ms')}ms  usage={row.get('usage')}")
    print("=" * 72)

    if row.get("error"):
        print("\n【错误】")
        print(row["error"])

    req = row.get("request") or {}
    print("\n【system prompt】")
    print(req.get("system") or "（空）")
    print("\n【user prompt】")
    print(req.get("user") or "（空）")
    print("\n【模型返回】")
    print(row.get("response") or "（空）")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
