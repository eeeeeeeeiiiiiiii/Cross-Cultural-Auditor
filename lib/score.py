"""确定性打分 —— 不让模型打分，保证同一份结果每次分数一致、可解释。"""

PENALTY = {"P0": 25, "P1": 12, "P2": 5, "P3": 2}

LEVELS = [
    (90, "安全", "ok"),
    (70, "需留意", "p2"),
    (50, "建议修改", "p1"),
    (30, "高风险", "p0"),
    (0, "危险", "p0"),
]


def compute_score(findings=None):
    findings = findings or []
    distribution = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
    penalty = 0

    for f in findings:
        sev = f.get("severity")
        if sev not in distribution:
            continue
        distribution[sev] += 1
        penalty += PENALTY[sev]

    score = max(0, min(100, 100 - penalty))
    label, tone = LEVELS[-1][1], LEVELS[-1][2]
    for min_score, name, t in LEVELS:
        if score >= min_score:
            label, tone = name, t
            break

    reason = "未发现需要修改的问题" if penalty == 0 else f"累计扣分 {penalty} 分（P0 −25 / P1 −12 / P2 −5 / P3 −2）"

    return {
        "score": score,
        "level": label,
        "tone": tone,
        "distribution": distribution,
        "penalty": penalty,
        "reason": reason,
    }
