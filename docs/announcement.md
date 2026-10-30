# RelayGuard public-preview announcement

Prepared on October 30, 2026. These messages target the v0.2.0 public preview and can be published only after its source, release and image are available at the linked repository. They are drafts, not evidence that any community post was published. Keep the source/release distinction until a new image containing these changes has actually been released. Record real verification results in [verification.md](verification.md); do not add unmeasured speed or adoption claims.

## English

**Title:** RelayGuard: scoped API keys with persistent response-byte budgets

RelayGuard is an early-stage MIT project for a narrow integration problem: give an internal job or external collaborator access to selected HTTP endpoints without handing over the provider's Bearer token.

It runs in front of one upstream API, issues expiring relay keys, and stores request and response-byte counters in SQLite. The response is buffered and checked before release, so a response that exceeds the configured budget is withheld in full. The v0.2.0 preview supports lifetime request and byte caps as well as per-minute limits, an offline policy checker, and a Korean operations console.

The local demo includes a synthetic CRM and does not require a provider account. Source, setup and limitations: [github.com/kwakhyun/relayguard](https://github.com/kwakhyun/relayguard), with an [English guide](https://github.com/kwakhyun/relayguard/blob/main/README.en.md).

There are tradeoffs: one provider account per deployment, bounded JSON/text responses, no streaming, no OAuth refresh and no distributed quota store. It does not check object ownership or stop data extraction within an allowed budget. Existing gateway stacks may already be a better fit. It has not undergone an independent security audit.

Feedback is welcome on whether the policy model fits a real integration, which protocol restrictions prevent adoption, and whether the documented security boundaries are correct. Please use synthetic examples in public issues and the repository's security reporting process for vulnerabilities.

Run the v0.2.0 source or `ghcr.io/kwakhyun/relayguard:0.2.0` for lifetime caps and the redesigned console. Earlier `0.1.1` images do not include them.

## 한국어

**제목:** RelayGuard 공개 — 원본 API 토큰 대신 범위와 데이터 한도가 있는 키 발급

내부 자동화나 외부 협력자에게 API 접근을 열어 줄 때, 원본 서비스 토큰을 전달하지 않고 필요한 경로와 사용량만 허용하는 작은 도구입니다. MIT 라이선스로 공개합니다.

RelayGuard는 하나의 upstream API 앞에서 만료되는 릴레이 키를 발급합니다. 요청 수와 응답 바이트를 SQLite에 기록하고, 응답 전체가 한도를 통과한 뒤에만 클라이언트로 보냅니다. v0.2.0 프리뷰에는 분당 제한에 더해 키 수명 전체의 요청 수와 바이트 한도, 실행 전 정책 검사, 한국어 운영 콘솔이 있습니다.

계정이나 실제 고객 데이터 없이 합성 CRM 데모를 실행할 수 있습니다. [저장소와 실행 방법](https://github.com/kwakhyun/relayguard)에 코드와 보호 범위, 한계를 정리했습니다.

범위는 작습니다. 하나의 서비스 계정과 작은 JSON/텍스트 API를 대상으로 하며, 스트리밍, OAuth 갱신, 객체별 권한 검사와 분산 예산은 지원하지 않습니다. 허용된 한도 안의 데이터 반출도 막지 못합니다. 기존 게이트웨이를 이미 운영한다면 거기에 통제를 추가하는 편이 나을 수 있습니다. 독립 보안 감사는 아직 받지 않았습니다.

실제 연동에서 필요한 정책이 무엇인지, 어떤 프로토콜 제한 때문에 도입하기 어려운지 피드백을 받고 싶습니다. 공개 이슈에는 비밀과 개인정보를 제거한 재현 예제를 올려 주세요. 취약점은 저장소의 보안 제보 절차를 이용해 주세요.

총 사용량 한도와 개편된 콘솔은 v0.2.0 소스 또는 `ghcr.io/kwakhyun/relayguard:0.2.0`으로 실행할 수 있습니다. 이전 `0.1.1` 이미지에는 포함되지 않습니다.

## Channel notes

- Repository announcement or discussion: use the full message and link to the runnable demo and limitations.
- GeekNews: use the Korean title and text; check the site's current submission rules and whether the account can post before publishing.
- Hacker News: excluded from automated publication. The current [site guidelines](https://news.ycombinator.com/newsguidelines.html) prohibit generated text and automated posting. These drafts must not be pasted there. If the maintainer chooses to participate personally, they should write their own account of the work and follow the [Show HN guidance](https://news.ycombinator.com/showhn.html).
- Avoid posting the same message into unrelated issues or discussions, requesting votes, implying endorsements, or claiming security certification. A public link is only recorded after the platform confirms publication.
