"""三套市场档案 —— 审查时注入 prompt，不依赖模型记忆。

加一个市场 = 加一份配置 + 补几条测试用例，不改任何逻辑。
"""

MARKETS = {
    "us": {
        "id": "us",
        "label": "美国",
        "code": "US",
        "locale": "en-US",
        "language": "English",
        "native_name": "English",
        "dir": "ltr",
        "focus": ["肤色与种族", "残障与包容", "FTC 功效宣称", "绝对化用语"],
        "brief": """目标读者：美国大众消费者，英语母语。
社会语境：种族与肤色议题高度敏感，"美白 / 变白 / whitening" 会被读作 colorism，同时可能构成 FDA 意义上的药品功效宣称（普通化妆品不得宣称改变肤色）。身材羞辱、残障歧视用语、性别刻板印象会被公开批评并可能引发抵制。
广告法：FTC 要求功效类与 "natural / organic" 类宣称有实证支撑；"#1 / best / 第一" 等最高级用语必须有可核实依据，否则属虚假广告。
表达习惯：直接、具体、第二人称；避免堆砌形容词与空洞口号；幽默可以，但不要碰身份议题。""",
    },
    "mena": {
        "id": "mena",
        "label": "中东",
        "code": "SA",
        "locale": "ar-SA",
        "language": "Arabic",
        "native_name": "العربية",
        "dir": "rtl",
        "focus": ["宗教与神祇", "女性形象", "斋月日历", "清真与饮食"],
        "brief": """目标读者：沙特及海湾地区阿拉伯语消费者，穆斯林占绝大多数。
宗教语境：伊斯兰价值观是广告审查的第一道门槛。任何神祇、多神暗示、宗教符号的戏仿都属严重冒犯；"女神 / 天后 / 守护神" 这类中文修辞直译后会被读作对宗教的不敬。猪、酒、左手、暴露身体属禁忌。
节日：斋月（Ramadan）与开斋节（Eid al-Fitr）是核心营销节点；"女神节 / 双十一" 这类中文造节在本地没有文化锚点。
广告法：沙特 GAMR、阿联酋 NMO 对广告内容有事先审查；促销与折扣表述需明确、不得夸大。
表达习惯：敬语与家庭价值优先；避免直接比较竞品；对女性形象的处理需端庄、避免物化。""",
    },
    "sea": {
        "id": "sea",
        "label": "东南亚",
        "code": "ID",
        "locale": "id-ID",
        "language": "Indonesian",
        "native_name": "Bahasa Indonesia",
        "dir": "ltr",
        "focus": ["清真认证", "宗教与王室", "肤色议题", "价格表述"],
        "brief": """目标读者：以印尼为主（穆斯林人口最多的国家），兼顾泰国、越南市场。
宗教语境：印尼在食品、化妆品上 "halal" 是硬性合规点——未取得 BPJPH 认证不得宣称清真；泰国对王室与佛教表述极度敏感，任何轻慢都可能触犯法律；越南对绝对化与比较广告有限制。
社会语境：肤色议题同样敏感，但公开讨论阈值低于欧美；社会偏集体主义，家庭与社群诉求比个人主义诉求有效。
表达习惯：价格敏感，促销信息要直白具体；印尼语偏好简洁口语，少用长定语；避免把东南亚当作一个同质市场来写。""",
    },
}

MARKET_IDS = list(MARKETS.keys())


def get_market(market_id: str):
    return MARKETS.get(market_id)


def is_market_id(market_id) -> bool:
    return isinstance(market_id, str) and market_id in MARKETS


def public_profile(market_id: str):
    m = MARKETS.get(market_id)
    if not m:
        return None
    return {
        "id": m["id"],
        "label": m["label"],
        "code": m["code"],
        "locale": m["locale"],
        "language": m["language"],
        "nativeName": m["native_name"],
        "dir": m["dir"],
        "focus": m["focus"],
    }
