"""Exercise the real gateway via HTTP against the local synthetic upstream."""
import asyncio
import time
import httpx

from .models import CredentialCreate, Policy, RouteRule


async def run_scenarios(store, base_url):
    issued = []
    scenarios = []

    def issue(name, paths=("/customers",), **limits):
        policy = Policy(routes=[RouteRule(method="GET", path=p, query_keys=["limit"] if p == "/customers" else []) for p in paths], **limits)
        item = store.create_credential(CredentialCreate(name="Demo: " + name, ttl_hours=1, policy=policy))
        issued.append(item["credential"]["id"])
        return item

    async with httpx.AsyncClient(base_url=base_url, timeout=10, trust_env=False, follow_redirects=False) as client:
        async def check(name, item, path, expected, method="GET"):
            response = await client.request(method, "/proxy" + path, headers={"Authorization": "Bearer " + item["token"]})
            reason = "allowed"
            if response.status_code >= 400:
                try:
                    reason = response.json()["error"]["code"]
                except (ValueError, KeyError, TypeError):
                    reason = "unexpected_response"
            scenarios.append({"name": name, "expected_status": expected, "actual_status": response.status_code,
                              "passed": response.status_code == expected, "reason": reason})
        try:
            normal = issue("최소 권한")
            await check("허용한 고객 조회", normal, "/customers?limit=2", 200)
            await check("대량 내보내기 경로 차단", normal, "/exports", 403)
            await check("허용하지 않은 쓰기 차단", normal, "/customers", 403, "POST")
            await check("미등록 쿼리 차단", normal, "/customers?debug=true", 403)
            small = issue("응답 크기", ("/bulk",), response_bytes_limit=128)
            await check("큰 응답 전체 보류", small, "/bulk", 413)
            # Keep the two fixed-window quota examples in one UTC minute.
            remaining = 60 - time.time() % 60
            if remaining < 5:
                await asyncio.sleep(remaining + 0.02)
            rate = issue("호출 한도", requests_per_minute=1)
            await check("호출 예산 첫 요청", rate, "/customers", 200)
            await check("호출 예산 초과 차단", rate, "/customers", 429)
            budget = issue("반출 예산", ("/payload",), response_bytes_limit=128, bytes_per_minute=128)
            await check("반출 예산 첫 응답", budget, "/payload", 200)
            await check("누적 반출 예산 초과 차단", budget, "/payload", 429)
            revoked = issue("즉시 해지")
            store.revoke(revoked["credential"]["id"])
            await check("해지된 키 차단", revoked, "/customers", 401)
            network = issue("네트워크 제한", ip_allowlist=["203.0.113.1/32"])
            await check("허용 대역 밖 요청 차단", network, "/customers", 403)
            redirect = issue("리디렉션", ("/redirect",))
            await check("업스트림 리디렉션 차단", redirect, "/redirect", 502)
        finally:
            for credential_id in issued:
                store.revoke(credential_id)
    return {"scenarios": scenarios, "passed": all(s["passed"] for s in scenarios)}
