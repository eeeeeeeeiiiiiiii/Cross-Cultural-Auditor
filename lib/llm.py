"""极简 LLM 客户端 —— 任何 OpenAI 兼容接口都能用。

DeepSeek / 通义 / OpenAI / Ollama 都走同一套 /chat/completions。
每次调用都会记一条日志到 logs/ai.jsonl（最近 N 条，见 lib/ailog.py）。
"""

import json
import time
from typing import Awaitable, Callable, Optional

import httpx

from lib import ailog


class LLMError(Exception):
    pass


class LLM:
    def __init__(self, base_url: str, api_key: str, model: str, smart_model: str = "", timeout: float = 45.0):
        self.base_url = (base_url or "").rstrip("/")
        self.endpoint = f"{self.base_url}/chat/completions"
        self.api_key = api_key
        self.model = model
        self.audit_model = smart_model or model
        self.timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, connect=10.0))
        return self._client

    async def aclose(self):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def headers(self):
        # 密钥只出现在请求头里，永远不进日志
        return {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}

    # ── 思考模式 ──
    # DeepSeek 新模型默认开启思考模式（effort=high），思维链会吃掉输出额度，
    # 结构化任务（翻译/审查/探针）根本不需要它，显式关掉更快也更稳。
    # 其它厂商不认识这个字段，传了可能 400，所以只对 DeepSeek 发。
    def _is_deepseek(self) -> bool:
        return "deepseek" in self.base_url.lower() or self.model.lower().startswith("deepseek")

    def _payload(
        self,
        model: str,
        system: str,
        user: str,
        *,
        stream: bool,
        max_tokens: int,
        temperature: Optional[float] = None,
        json_mode: bool = False,
    ) -> dict:
        payload = {
            "model": model,
            "stream": stream,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        if self._is_deepseek():
            payload["thinking"] = {"type": "disabled"}
        return payload

    # ── 日志 ──
    def _record(self, payload, started, *, response="", error=None, usage=None, meta=None):
        meta = meta or {}
        ailog.record(
            purpose=meta.get("purpose", "chat"),
            market=meta.get("market", ""),
            model=str(payload.get("model", "")),
            endpoint=self.endpoint,
            request={
                "system": (payload.get("messages") or [{}, {}])[0].get("content", ""),
                "user": (payload.get("messages") or [{}, {}])[1].get("content", ""),
            },
            response=response,
            error=str(error) if error else None,
            ms=int((time.time() - started) * 1000),
            usage=usage,
        )

    # ── 执行体 ──
    async def _exec(self, payload: dict) -> tuple[str, Optional[dict]]:
        try:
            resp = await self.client.post(self.endpoint, json=payload, headers=self.headers)
        except httpx.TimeoutException:
            raise LLMError(f"模型超时（{self.timeout}s）")
        except httpx.HTTPError as e:
            raise LLMError(f"连不上模型接口：{e}")

        if resp.status_code != 200:
            raise LLMError(f"模型返回 {resp.status_code}：{resp.text[:300]}")

        try:
            data = resp.json()
            message = data["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise LLMError("模型返回结构异常")

        text = message.get("content") or ""
        reasoning = message.get("reasoning_content") or ""

        if not text.strip():
            # 思考模式把输出额度吃光时，content 会是空的，只有 reasoning_content
            if reasoning.strip():
                raise LLMError(
                    f"模型只返回了思考过程（{len(reasoning)} 字），回答被输出上限截断；"
                    "请关闭思考模式或调大输出上限"
                )
            raise LLMError("模型返回了空内容")

        return text, data.get("usage")

    async def _stream(self, payload: dict, on_delta: Callable[[str], Awaitable[None]]) -> str:
        full = ""
        try:
            async with self.client.stream(
                "POST", self.endpoint, json=payload, headers=self.headers
            ) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise LLMError(f"模型返回 {resp.status_code}：{body[:300].decode('utf-8', 'ignore')}")

                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(raw)
                    except Exception:
                        continue
                    try:
                        delta = chunk["choices"][0]["delta"].get("content")
                    except (KeyError, IndexError, AttributeError):
                        delta = None
                    if delta:
                        full += delta
                        await on_delta(delta)
        except httpx.TimeoutException:
            raise LLMError(f"模型超时（{self.timeout}s）")
        except httpx.HTTPError as e:
            raise LLMError(f"连不上模型接口：{e}")

        if not full.strip():
            raise LLMError("模型没有返回任何内容（可能仍在思考模式，或被输出上限截断）")
        return full

    # ── 对外接口 ──
    async def translate_stream(
        self,
        system: str,
        user: str,
        on_delta: Callable[[str], Awaitable[None]],
        meta: Optional[dict] = None,
    ) -> str:
        payload = self._payload(self.model, system, user, stream=True, max_tokens=1200, temperature=0.5)
        meta = {**(meta or {}), "purpose": (meta or {}).get("purpose", "translate")}

        started = time.time()
        try:
            full = await self._stream(payload, on_delta)
        except LLMError as e:
            self._record(payload, started, error=e, meta=meta)
            raise
        self._record(payload, started, response=full, meta=meta)
        return full

    async def _post(
        self,
        system: str,
        user: str,
        *,
        json_mode: bool,
        model: str,
        max_tokens: int = 4000,
        purpose: str = "chat",
        meta: Optional[dict] = None,
    ) -> str:
        payload = self._payload(
            model, system, user, stream=False, max_tokens=max_tokens, temperature=0.2, json_mode=json_mode
        )
        meta = {**(meta or {}), "purpose": purpose}

        started = time.time()
        try:
            text, usage = await self._exec(payload)
        except LLMError as e:
            self._record(payload, started, error=e, meta=meta)
            raise
        self._record(payload, started, response=text, usage=usage, meta=meta)
        return text

    async def audit(self, system: str, user: str, meta: Optional[dict] = None) -> str:
        return await self._post(
            system, user, json_mode=True, model=self.audit_model, purpose="audit", meta=meta
        )

    async def audit_plain(self, system: str, user: str, meta: Optional[dict] = None) -> str:
        """去掉 response_format 再试：部分兼容接口不支持该参数会直接 400。"""
        return await self._post(
            system, user, json_mode=False, model=self.audit_model, purpose="audit", meta=meta
        )

    async def translate_once(self, system: str, user: str, meta: Optional[dict] = None) -> str:
        """非流式翻译：给「AI 翻译本页」按钮用，一次性返回整段。"""
        return await self._post(
            system, user, json_mode=False, model=self.model, purpose="translate", meta=meta
        )

    async def list_models(self) -> list[str]:
        """问服务商要一份可用的模型列表，别让我们猜。"""
        url = f"{self.base_url}/models"
        started = time.time()
        try:
            resp = await self.client.get(url, headers=self.headers)
        except httpx.TimeoutException:
            raise LLMError(f"模型列表请求超时（{self.timeout}s）")
        except httpx.HTTPError as e:
            raise LLMError(f"连不上模型接口：{e}")

        if resp.status_code == 401:
            raise LLMError("密钥无效或没有权限（401）")
        if resp.status_code != 200:
            raise LLMError(f"接口返回 {resp.status_code}：{resp.text[:160]}")

        try:
            data = resp.json()
        except ValueError:
            raise LLMError("返回的不是 JSON，可能不是 OpenAI 兼容接口")

        items = data.get("data") or data.get("models") or []
        ids = [i.get("id") for i in items if isinstance(i, dict) and i.get("id")]
        if not ids:
            raise LLMError("该接口没有返回模型列表（有些中转不实现 /models）")

        ailog.record(
            purpose="models",
            model="",
            endpoint=url,
            request={"system": "", "user": ""},
            response=", ".join(sorted(ids)[:50]),
            ms=int((time.time() - started) * 1000),
        )
        return sorted(ids)

    async def ping(self, meta: Optional[dict] = None) -> str:
        # 16 个 token 的探针，思考模式必须先关掉，否则全被思维链吃光
        payload = self._payload(
            self.model,
            "You are a health check. Reply with the single word: ok",
            "ping",
            stream=False,
            max_tokens=16,
            temperature=0,
        )
        meta = {**(meta or {}), "purpose": "ping"}

        started = time.time()
        try:
            text, usage = await self._exec(payload)
        except LLMError as e:
            self._record(payload, started, error=e, meta=meta)
            raise
        self._record(payload, started, response=text, usage=usage, meta=meta)
        return text.strip()
