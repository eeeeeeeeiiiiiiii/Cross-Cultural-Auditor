"""跨文化审核官 · Cross-Cultural Auditor —— 后端

启动：
    python server.py

依赖：fastapi / uvicorn / httpx（见 requirements.txt）
"""

import asyncio
import json
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from config.markets import MARKET_IDS, get_market, is_market_id, public_profile
from lib import ailog
from lib.llm import LLM, LLMError
from lib.prompts import build_audit_prompt, build_translate_prompt
from lib.score import compute_score
from lib.validate import clean_tone, parse_json_loose, parse_llm_block, parse_request, sanitize_audit

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
FIXTURE = PUBLIC / "fixtures" / "demo.json"


# ────────────────────────── .env（不装 python-dotenv） ──────────────────────────

def load_env():
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env()

PLACEHOLDER = "在这里填你的key"


def _clean_key(raw: str) -> str:
    key = (raw or "").strip()
    # key 一定是纯 ASCII；含中文说明基本就是没改 .env.example 里的占位符
    if PLACEHOLDER in key or key == "sk-" or not key.isascii():
        return ""
    return key


CONFIG = {
    "host": os.environ.get("HOST", "127.0.0.1"),
    "port": int(os.environ.get("PORT") or 3000),
    "base_url": (os.environ.get("LLM_BASE_URL") or "https://api.deepseek.com").strip(),
    "api_key": _clean_key(os.environ.get("LLM_API_KEY", "")),
    "model": (os.environ.get("LLM_MODEL") or "deepseek-flash").strip(),
    "smart_model": (os.environ.get("LLM_MODEL_SMART") or "").strip(),
    "timeout": float(os.environ.get("TIMEOUT_MS") or 45000) / 1000.0,
}

llm = LLM(
    base_url=CONFIG["base_url"],
    api_key=CONFIG["api_key"],
    model=CONFIG["model"],
    smart_model=CONFIG["smart_model"],
    timeout=CONFIG["timeout"],
)

# 服务端 .env 没配 key 时的默认状态；前端可以按请求覆盖（见 resolve_llm）
MOCK = not llm.enabled


def resolve_llm(override):
    """按请求决定用哪套模型配置。

    优先级：前端传的配置（用户在页面里填的） > 服务端 .env > 演示数据。
    返回 (实例, 是否临时创建需要关闭, 是否走演示数据)。
    """
    if override and override.get("apiKey"):
        inst = LLM(
            base_url=override["baseUrl"],
            api_key=override["apiKey"],
            model=override["model"],
            smart_model=override.get("smartModel") or override["model"],
            timeout=CONFIG["timeout"],
        )
        return inst, True, False

    if llm.enabled:
        return llm, False, False

    return llm, False, True


# ────────────────────────── 演示数据 ──────────────────────────

_fixture_cache = None


def load_fixture():
    global _fixture_cache
    if _fixture_cache is None:
        _fixture_cache = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return _fixture_cache


# ────────────────────────── SSE 小工具 ──────────────────────────

def frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


# ────────────────────────── 单市场流水线 ──────────────────────────

async def run_market(market_id: str, opts: dict, send, inst, mock: bool):
    if not get_market(market_id):
        await send("translation.error", {"market": market_id, "message": "未知市场"})
        return

    provided = (opts.get("translations") or {}).get(market_id, "").strip()
    origin = "user" if provided else "ai"
    translation = ""

    if provided:
        # 主路径：用户自带译文，跳过翻译直接审。
        # 不做「AI 翻完再自己审」——那等于让同一个模型给自己打分。
        translation = provided
    else:
        await send("progress", {"market": market_id, "stage": "translate"})

        if mock:
            fake = (load_fixture().get("markets") or {}).get(market_id)
            if not fake:
                await send("translation.error", {"market": market_id, "message": "没有该市场的演示数据"})
                return
            await asyncio.sleep(0.25)
            text = fake["translation"]
            for i in range(0, len(text), 3):
                chunk = text[i : i + 3]
                translation += chunk
                await send("translation.delta", {"market": market_id, "text": chunk})
                await asyncio.sleep(0.016)
        else:
            prompt = build_translate_prompt(market_id, opts["tone"])
            user = prompt["user_template"].format(source=opts["source"])

            async def on_delta(chunk: str):
                nonlocal translation
                translation += chunk
                await send("translation.delta", {"market": market_id, "text": chunk})

            try:
                translation = (await inst.translate_stream(prompt["system"], user, on_delta, meta={"market": market_id})).strip()
            except LLMError as e:
                await send("translation.error", {"market": market_id, "message": str(e)})
                return
            except Exception as e:  # 兜底：任何意外都不能让整条流挂掉
                await send("translation.error", {"market": market_id, "message": f"翻译失败：{e}"})
                return

    if not translation.strip():
        await send("translation.error", {"market": market_id, "message": "译文为空"})
        return

    await send("translation.done", {"market": market_id, "text": translation, "source": origin})
    await send("progress", {"market": market_id, "stage": "audit"})

    try:
        if mock:
            await asyncio.sleep(0.45)
            fake = load_fixture()["markets"][market_id]
            result = sanitize_audit(fake["audit"], translation=translation, min_conf=0.0)
            result["summary"] = fake["audit"].get("summary") or result["summary"]
        else:
            result = await audit_market(market_id, opts, translation, provided=bool(provided), inst=inst)

        scored = compute_score(result["findings"])
        await send(
            "audit.result",
            {
                "market": market_id,
                "summary": result["summary"],
                "findings": result["findings"],
                "dropped": result["dropped"],
                "source": origin,
                **scored,
            },
        )
    except LLMError as e:
        await send("audit.error", {"market": market_id, "message": str(e)})
    except Exception as e:
        await send("audit.error", {"market": market_id, "message": f"审查失败：{e}"})


async def audit_market(market_id: str, opts: dict, translation: str, provided: bool = False, inst=None) -> dict:
    inst = inst or llm
    prompt = build_audit_prompt(
        market_id, opts["source"], translation, opts["strictness"], provided=provided
    )

    last_error = None
    for call in (inst.audit, inst.audit_plain):
        try:
            text = await call(prompt["system"], prompt["user"], meta={"market": market_id})
            obj = parse_json_loose(text)
            if obj is not None:
                return sanitize_audit(obj, translation=translation, min_conf=prompt["min_conf"])
            last_error = LLMError("模型没有返回合法 JSON")
        except LLMError as e:
            last_error = e
            # 网络 / 鉴权 / 超时错误，重试也没用
            if any(k in str(e) for k in ("连不上", "401", "403", "超时")):
                break

    raise last_error or LLMError("审查失败")


# ────────────────────────── 应用 ──────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await llm.aclose()


class UTF8JSONResponse(JSONResponse):
    """默认 JSONResponse 不带 charset，PowerShell / curl 直接看会认错编码。"""

    media_type = "application/json; charset=utf-8"


app = FastAPI(title="Cross-Cultural Auditor", lifespan=lifespan, default_response_class=UTF8JSONResponse)


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "mock": MOCK,
        "model": None if MOCK else CONFIG["model"],
        "auditModel": None if MOCK else llm.audit_model,
        "markets": MARKET_IDS,
    }


@app.get("/api/markets")
async def markets():
    return [public_profile(m) for m in MARKET_IDS]


@app.post("/api/audit")
async def audit_endpoint(request: Request):
    try:
        body = await request.json()
    except Exception:
        return UTF8JSONResponse({"error": "请求体不是合法 JSON"}, status_code=400)

    ok, value, error = parse_request(body)
    if not ok:
        return UTF8JSONResponse({"error": error}, status_code=400)

    selected = [m for m in value["markets"] if is_market_id(m)]
    if not selected:
        return UTF8JSONResponse({"error": "未知的市场标识"}, status_code=400)

    inst, owned, mock = resolve_llm(value.get("llm"))

    queue: asyncio.Queue = asyncio.Queue()

    async def send(event: str, data: dict):
        await queue.put((event, data))

    async def runner():
        try:
            await asyncio.gather(*(run_market(m, value, send, inst, mock) for m in selected))
        except Exception as e:  # 兜底
            await send("error", {"message": str(e)})
        finally:
            await queue.put(None)

    async def stream():
        task = asyncio.create_task(runner())
        yield frame(
            "meta",
            {
                "markets": selected,
                "model": "mock" if mock else inst.audit_model,
                "mock": mock,
                "baseUrl": None if mock else inst.base_url,
            },
        )
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                yield frame(item[0], item[1])
            yield frame("done", {"ok": True})
        finally:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            if owned:
                await inst.aclose()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/translate")
async def translate_endpoint(request: Request):
    """「AI 翻译本页」按钮用：兜底给没准备译文的用户，结果落进输入框由用户先改再审。"""
    try:
        body = await request.json()
    except Exception:
        return UTF8JSONResponse({"error": "请求体不是合法 JSON"}, status_code=400)

    source = body.get("source").strip() if isinstance(body.get("source"), str) else ""
    market_id = body.get("market")
    tone = clean_tone(body.get("tone"))

    if len(source) < 4:
        return UTF8JSONResponse({"error": "文案太短了，至少 4 个字"}, status_code=400)
    if not is_market_id(market_id):
        return UTF8JSONResponse({"error": "未知的市场标识"}, status_code=400)

    inst, owned, mock = resolve_llm(body.get("llm") if isinstance(body.get("llm"), dict) else None)

    try:
        if mock:
            fake = (load_fixture().get("markets") or {}).get(market_id)
            if not fake:
                return UTF8JSONResponse({"error": "没有该市场的演示数据"}, status_code=400)
            await asyncio.sleep(0.35)
            text = fake["translation"]
        else:
            prompt = build_translate_prompt(market_id, tone)
            user = prompt["user_template"].format(source=source)
            text = await inst.translate_once(prompt["system"], user, meta={"market": market_id})
    except LLMError as e:
        return UTF8JSONResponse({"error": str(e)}, status_code=502)
    finally:
        if owned:
            await inst.aclose()

    return {"text": text.strip(), "market": market_id, "source": "ai"}


@app.post("/api/llm/test")
async def llm_test(request: Request):
    """测试连接：前端设置面板里的「测试连接」按钮。"""
    try:
        body = await request.json()
    except Exception:
        return UTF8JSONResponse({"error": "请求体不是合法 JSON"}, status_code=400)

    cfg, err = parse_llm_block(body.get("llm"))
    if err:
        return UTF8JSONResponse({"error": err}, status_code=400)

    started = time.time()
    inst = LLM(
        base_url=cfg["baseUrl"],
        api_key=cfg["apiKey"],
        model=cfg["model"],
        timeout=min(CONFIG["timeout"], 20.0),
    )
    try:
        reply = await inst.ping()
    except LLMError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=200)
    except Exception as e:
        return UTF8JSONResponse({"ok": False, "error": f"意外错误：{e}"}, status_code=200)
    finally:
        await inst.aclose()

    return {
        "ok": True,
        "ms": int((time.time() - started) * 1000),
        "model": cfg["model"],
        "reply": reply[:40],
    }


@app.post("/api/llm/models")
async def llm_models(request: Request):
    """向服务商要一份可用模型列表 —— 模型名会下线、会改名，不能写死在前端。"""
    try:
        body = await request.json()
    except Exception:
        return UTF8JSONResponse({"error": "请求体不是合法 JSON"}, status_code=400)

    raw = body.get("llm") if isinstance(body, dict) else None
    if not isinstance(raw, dict):
        return UTF8JSONResponse({"error": "缺少模型配置"}, status_code=400)

    base = str(raw.get("baseUrl") or "").strip().rstrip("/")
    key = str(raw.get("apiKey") or "").strip()
    if not key:
        return UTF8JSONResponse({"error": "请填写 API 密钥"}, status_code=400)
    if not base.startswith(("http://", "https://")):
        return UTF8JSONResponse({"error": "接口地址必须以 http:// 或 https:// 开头"}, status_code=400)

    inst = LLM(base_url=base, api_key=key, model="placeholder", timeout=min(CONFIG["timeout"], 20.0))
    try:
        models = await inst.list_models()
    except LLMError as e:
        return UTF8JSONResponse({"ok": False, "error": str(e)}, status_code=200)
    except Exception as e:
        return UTF8JSONResponse({"ok": False, "error": f"意外错误：{e}"}, status_code=200)
    finally:
        await inst.aclose()

    return {"ok": True, "models": models[:200]}


@app.get("/api/logs")
async def get_logs(limit: int = 60, errors: bool = False):
    """最近 N 条 AI 调用记录，新的在前。"""
    rows = ailog.read_all()
    if errors:
        rows = [r for r in rows if not r.get("ok")]
    cap = max(1, min(int(limit or 60), 200))
    items = list(reversed(rows[-cap:]))
    return {"total": len(rows), "limit": ailog.limit(), "items": items}


@app.post("/api/logs/clear")
async def clear_logs():
    ailog.clear()
    return {"ok": True}


# 静态文件必须最后挂载，否则会吃掉 /api 路由
app.mount("/", StaticFiles(directory=str(PUBLIC), html=True), name="static")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    line = "-" * 56
    # flush=True：输出被重定向到文件/管道时也能立刻看到
    print(f"\n  跨文化审核官 · Cross-Cultural Auditor", flush=True)
    print(f"  {line}", flush=True)
    print(f"  地址   http://localhost:{CONFIG['port']}", flush=True)
    print(f"  演示   http://localhost:{CONFIG['port']}/?demo=1", flush=True)
    print(f"  日志   logs/ai.jsonl（最近 {ailog.limit()} 次调用）", flush=True)
    if MOCK:
        print(f"  模式   演示数据（未检测到 LLM_API_KEY）", flush=True)
        print(f"  提示   复制 .env.example 为 .env，填入 key 后重启即可调用真实模型", flush=True)
    else:
        print(f"  模型   {CONFIG['model']}  ->  {CONFIG['base_url']}", flush=True)
        print(f"  审查   {llm.audit_model}", flush=True)
    print(f"  {line}\n", flush=True)

    import uvicorn

    uvicorn.run(app, host=CONFIG["host"], port=CONFIG["port"], log_level="warning")


if __name__ == "__main__":
    main()
