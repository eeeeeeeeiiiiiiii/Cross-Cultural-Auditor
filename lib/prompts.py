"""翻译 / 审查两套 prompt。市场档案从 config 注入，不写死。"""

from config.markets import get_market

TONE_HINT = {
    "premium": "高端克制，少用感叹号，用具体细节建立价值感",
    "friendly": "亲切口语，像朋友推荐，可以有一点点俏皮",
    "professional": "专业可信，偏 B 端，强调参数与可信度",
}

STRICTNESS_RULE = {
    "loose": "只报 P0 与 P1。宁可漏报，也不要报 P2/P3。",
    "standard": "报 P0 / P1 / P2。P3 只在非常明显时给。",
    "strict": "P0 到 P3 全报，但仍禁止为凑数而报。",
}

CONFIDENCE_RULE = {"loose": 0.75, "standard": 0.6, "strict": 0.4}


CATEGORY_GLOSSARY = """类别代号（只能从中选一个）：
- skin_race  肤色与种族：把"白"当卖点、肤色描写、人种暗示、colorism
- religion   宗教与节日：宗教符号误用、多神/神祇暗示、斋月与清真、节日错位
- gender     性别与刻板印象：物化女性、贤妻良母叙事、男性凝视、默认性别角色
- inclusive  残障与包容：能力歧视用语、身心障碍的不当表述
- legal      法律与广告合规：绝对化用语、功效宣称、比较广告、未证实的认证
- symbol     符号与意象：颜色、动物、手势、数字、方向、身体部位的文化含义
- tone       语气与礼数：敬语缺失、祈使语气过强、称呼失当、T-V 区分
- literal    直译失真：成语、双关、谐音、语义空缺，读起来"不像本地人说的\""""


def build_translate_prompt(market_id: str, tone: str = "professional"):
    m = get_market(market_id)
    if not m:
        raise ValueError(f"未知市场：{market_id}")

    system = f"""你是资深{m['label']}本地文案，母语{m['language']}，长期为中国出海品牌做本地化改写。
你的任务是把中文营销文案改写成{m['label']}市场真正会用的{m['language']}文案。

市场背景：
{m['brief']}

改写要求：
1. 不要逐字直译。按目标市场的表达习惯重写，保留全部卖点与事实，绝不新增原文没有的信息。
2. 长度与原文相当（±40%），营销文案该短就短。
3. 语气：{TONE_HINT.get(tone) or f'按用户要求——{tone}'}。
4. 品牌名、型号、专有名词保持原样，不要翻译。
5. 不要为了"有冲击力"而加最高级用语或功效承诺。
6. 只输出译文正文：不要解释、不要加引号、不要写"译文："、不要分段标题。"""

    return {"system": system, "user_template": "中文原文：\n{source}"}


def build_audit_prompt(
    market_id: str,
    source: str,
    translation: str,
    strictness: str = "standard",
    provided: bool = False,
):
    m = get_market(market_id)
    if not m:
        raise ValueError(f"未知市场：{market_id}")

    min_conf = CONFIDENCE_RULE.get(strictness, 0.6)

    origin_note = (
        "这段译文由用户自行提供，可能来自机翻、外包或同事，用户已经打算按它发布。直接审查它，不要整段重写，只给出可原位替换的片段。"
        if provided
        else "这段译文由 AI 生成，可能会避开一些本地敏感点。请把它当作「将要发布出去的稿件」来审，不要因为它是 AI 写的就放松标准。"
    )

    system = f"""你是{m['label']}市场的本土品牌顾问，审查过大量中国品牌的出海文案。
你要审的不是语法，而是"这句话在本地会不会出事"。

{origin_note}

市场背景：
{m['brief']}

{CATEGORY_GLOSSARY}

判定原则：
1. 只报会造成真实商业损失的问题。正常、得体的表达不要报。
2. 每条必须锚定译文中的具体片段，禁止"整体语气偏硬"这类无法定位的结论。
3. 必须给可直接替换的改写，禁止"建议调整措辞"这种废话。
4. 不确定就降低 confidence，不要为了凑数而报。{STRICTNESS_RULE.get(strictness, STRICTNESS_RULE['standard'])}
5. 禁止编造法规条款编号、监管机构处罚案例。无法确认时只讲文化机制。
6. 区分"冒犯"（P0/P1）与"不地道"（P2/P3），不要一律标红。
7. 最多 6 条，按严重度从高到低排序。没有问题时返回空数组。

引用规则（最重要，违反会导致结果无法使用）：
- sourceQuote 必须是【中文原文】中逐字连续存在的片段。
- targetQuote 必须是【译文】中逐字连续存在的片段，包括大小写与标点，不要改写、不要省略号。
- 如果某条问题无法在译文中定位到具体连续片段，就不要报它。
- suggestions[].text 必须能原位替换 targetQuote：语法位置相同、大小写习惯相同、长度相近。
- targetQuote 整个片段会被替换，所以它自身必须是完整、可替换的短语，不要只截半个词。

只输出 JSON，不要 markdown 代码块，不要任何解释文字。结构：
{{
  "summary": "一句话总体结论，不超过40字",
  "findings": [
    {{
      "category": "上面 8 个代号之一",
      "severity": "P0 | P1 | P2 | P3",
      "sourceQuote": "原文中的逐字片段",
      "targetQuote": "译文中的逐字片段",
      "issue": "一句话说清问题，不超过30字",
      "why": "2-3 句文化解释，要讲机制，不要堆形容词",
      "suggestions": [{{ "text": "可直接替换的改写", "note": "为什么这样改是安全的" }}],
      "confidence": 0.0
    }}
  ]
}}"""

    user = f"""【中文原文】
{source}

【{m['label']}译文（{m['language']}）】
{translation}

请按上述原则审查，只输出 JSON。confidence 低于 {min_conf} 的条目不要输出。"""

    return {"system": system, "user": user, "min_conf": min_conf}
