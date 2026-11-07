# 배포와 운영

먼저 로컬 `relayguard demo`로 흐름을 확인한다. 배포 대상은 운영자가 제어하는 연동 앱과 API다. 제삼자가 고정해 놓은 SaaS 간 OAuth 연결을 이 프로젝트가 자동으로 가로채거나 교체하지 않는다.

## 설정

| 변수 | 의미 |
| --- | --- |
| `RELAYGUARD_UPSTREAM_URL` | HTTPS origin. 경로, 사용자 정보, 쿼리, fragment 금지. 예: `https://api.example.com` |
| `RELAYGUARD_UPSTREAM_TOKEN` | 제공자의 최소 권한 Bearer 토큰. 운영 비밀 저장소에서 주입 |
| `RELAYGUARD_ADMIN_TOKEN` | 최소 32자의 고엔트로피 관리자 비밀. `relayguard generate-admin-token`으로 생성 |
| `RELAYGUARD_DB` | 로컬 SQLite 파일. 기본값 `.relayguard/relayguard.db` |
| `RELAYGUARD_ADMIN_TOKEN_FILE` | 관리자 토큰을 읽을 파일. 같은 이름의 일반 토큰 변수와 동시 설정 금지 |
| `RELAYGUARD_UPSTREAM_TOKEN_FILE` | 원본 토큰을 읽을 파일. 같은 이름의 일반 토큰 변수와 동시 설정 금지 |
| `RELAYGUARD_MAX_REQUEST_BYTES` | 요청 본문 한도, 1–1,048,576바이트. 기본 65,536 |
| `RELAYGUARD_UPSTREAM_TIMEOUT_SECONDS` | upstream 전체 응답 제한 시간, 0.1–60초. 기본 5 |
| `RELAYGUARD_UPSTREAM_AUTH_HEADER` | 원본 토큰을 넣을 헤더 이름. 기본 `Authorization`. 예: `X-API-Key`. `Host`, `Content-Type`, `Accept`, 전달/연결 헤더는 지정할 수 없다 |
| `RELAYGUARD_UPSTREAM_AUTH_SCHEME` | 토큰 앞에 붙일 접두어. 기본 `Bearer`. `none`이면 토큰 원문만 보낸다 |
| `RELAYGUARD_ADMIN_TOKEN_NEXT` (`_FILE`) | 선택. 관리자 토큰 교체 기간에 함께 허용할 다음 관리자 토큰. 최소 32자, 다른 비밀과 달라야 한다 |
| `RELAYGUARD_METRICS_TOKEN` (`_FILE`) | 선택. `/metrics`만 읽을 수 있는 수집용 토큰. 설정하지 않으면 관리자 토큰으로만 읽는다 |
| `RELAYGUARD_ALERT_WEBHOOK_URL` (`_FILE`) | 선택. 보안·한도 알림을 받을 HTTPS 웹훅. 비밀 경로가 들어간 URL은 `_FILE`로 주입한다 |
| `RELAYGUARD_ALERT_DENY_THRESHOLD` | 키 하나가 60초 안에 이 횟수만큼 거부되면 알림. 기본 20 |
| `RELAYGUARD_ALERT_COOLDOWN_SECONDS` | 같은 종류·같은 키의 알림을 다시 보내기 전 대기 시간. 기본 600, 0–86400 |

API 계정이 여러 개면 격리된 게이트웨이 배포를 나눈다. 프로세스를 재시작해야 환경변수의 토큰 교체가 적용된다. 원본 제공자의 OAuth refresh는 자동 수행하지 않는다. Python CLI는 `.env`를 자동으로 읽지 않는다. Docker Compose는 프로젝트의 `.env`를 읽어 `compose.yaml`의 변수에 적용한다.

비밀 파일은 ASCII 한 줄이며 끝의 LF 또는 CRLF 한 개를 허용한다. 파일과 환경변수 값이 함께 설정되어 있거나 파일이 없으면 시작을 거부한다. 파일 경로와 비밀 내용은 오류 메시지에 포함하지 않는다. 비밀 저장소가 만든 파일을 실행 사용자에게만 읽기 가능하게 마운트한다. 파일을 바꾼 뒤에도 재시작해야 한다.

```bash
export RELAYGUARD_ADMIN_TOKEN_FILE='/run/secrets/relayguard_admin'
export RELAYGUARD_UPSTREAM_TOKEN_FILE='/run/secrets/provider_token'
# 이 방식을 쓸 때 일반 토큰 변수는 설정하지 않는다.
relayguard check-config
```

`check-config`는 설정 형식과 비밀 파일을 확인한다. DB 생성, provider 접속, 실제 provider 토큰 유효성 검사는 수행하지 않는다. 기본 Compose 파일은 환경변수 주입 방식이다. `_FILE`을 사용하려면 Compose의 해당 일반 토큰 항목을 제거하고, `secrets` 또는 읽기 전용 bind mount와 `_FILE` 변수를 함께 정의한다.

## Docker 이미지로 실행

공개 이미지 `ghcr.io/kwakhyun/relayguard:0.2.0`은 `linux/amd64`와 `linux/arm64`용이다. Docker 로그인 없이 내려받을 수 있다. 다음 예제의 URL과 원본 토큰을 실제 값으로 바꾸고, 생성한 관리자 토큰을 안전하게 보관한다.

```bash
export RELAYGUARD_UPSTREAM_URL='https://your-api.example.com'
export RELAYGUARD_UPSTREAM_TOKEN='replace-with-provider-token'
export RELAYGUARD_ADMIN_TOKEN="$(docker run --rm \
  ghcr.io/kwakhyun/relayguard:0.2.0 relayguard generate-admin-token)"

docker run -d --name relayguard --restart unless-stopped \
  -p 127.0.0.1:8810:8810 \
  --env RELAYGUARD_UPSTREAM_URL --env RELAYGUARD_UPSTREAM_TOKEN \
  --env RELAYGUARD_ADMIN_TOKEN \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount type=volume,source=relayguard-data,target=/data \
  ghcr.io/kwakhyun/relayguard:0.2.0

curl --fail http://127.0.0.1:8810/healthz
curl --fail http://127.0.0.1:8810/readyz
```

콘솔은 `http://127.0.0.1:8810`에 있다. `docker logs relayguard`로 시작 상태를 보고 `docker stop relayguard`, `docker start relayguard`로 중지와 재시작을 할 수 있다. 환경변수를 바꾸려면 컨테이너를 중지하고 제거한 뒤 같은 볼륨으로 다시 생성한다.

이미지는 비루트 사용자 `10001:10001`로 실행된다. 예제는 읽기 전용 루트 파일시스템, 임시 `/tmp`, capability 제거와 `no-new-privileges`를 적용한다. SQLite는 `relayguard-data` 볼륨의 `/data/relayguard.db`에 남는다. 직접 호스트 디렉터리를 마운트할 때는 UID/GID `10001:10001`의 쓰기 권한이 필요하다.

데모 실행은 [README의 Docker 명령](../README.md#바로-실행)을 사용한다. 데모와 운영 DB는 별도 볼륨으로 분리한다.

## Docker Compose

`compose.yaml`은 미리 빌드한 GHCR 이미지로 일반 게이트웨이를 실행한다. 데모 CRM은 포함하지 않는다. 저장소 디렉터리에서 위 세 환경변수를 설정하거나, `.env.example`을 `.env`로 복사해 값을 입력한 뒤 실행한다. `.env`에는 실제 토큰이 들어가므로 저장소에 커밋하지 않는다.

```bash
docker compose pull
docker compose up -d
docker compose ps
```

호스트에는 `127.0.0.1:8810`만 노출하며 보안 옵션과 영속 볼륨은 Compose 파일에 포함되어 있다. v0.2.0 Compose의 상태 검사는 `/readyz`로 DB 쓰기 준비 상태를 확인한다. `docker compose down`은 컨테이너를 제거하고 DB 볼륨은 유지한다. `down --volumes`는 DB까지 삭제하므로 데이터 초기화가 필요할 때만 사용한다.

## 이미지 선택과 직접 빌드

[GHCR 패키지](https://github.com/users/kwakhyun/packages/container/package/relayguard)에서 버전 태그 `0.2.0`, 최신 릴리스 `latest`, 소스 커밋의 `sha-<commit>` 태그를 확인할 수 있다. 운영에서는 검증한 digest로 이미지를 고정한다.

```bash
docker pull ghcr.io/kwakhyun/relayguard:0.2.0
docker image inspect ghcr.io/kwakhyun/relayguard:0.2.0 \
  --format '{{index .RepoDigests 0}}'
```

출력된 `ghcr.io/kwakhyun/relayguard@sha256:...`를 `docker run`의 이미지명 또는 `compose.yaml`의 `image` 값으로 사용한다. Dockerfile의 Python 베이스도 OCI index digest로 고정한다. digest는 콘텐츠 식별자이며 별도 서명을 뜻하지 않는다.

소스에서 수정한 이미지를 실행하려면 저장소 루트에서 빌드한다.

```bash
docker build --pull -t relayguard:local .
```

이후 실행 명령의 GHCR 이미지명을 `relayguard:local`로 바꾼다. [컨테이너 워크플로](https://github.com/kwakhyun/relayguard/actions/workflows/container.yml)는 각 아키텍처의 네이티브 러너에서 빌드와 컨테이너 실행 검증을 수행한 뒤 이미지를 게시한다. 검증 결과는 각 Actions 실행에서 확인한다.

## Python으로 직접 실행

Python 환경에 패키지를 설치했다면 세 필수 변수를 export하고 쓰기 가능한 DB 경로를 지정한다.

```bash
export RELAYGUARD_ADMIN_TOKEN="$(relayguard generate-admin-token)"
export RELAYGUARD_DB='.relayguard/relayguard.db'
relayguard serve --host 127.0.0.1 --port 8810
```

## 관리자 토큰 교체

재시작은 필요하지만 콘솔과 자동화가 끊기지 않게 두 단계로 바꾼다.

1. 새 토큰을 만들어 `RELAYGUARD_ADMIN_TOKEN_NEXT`로 주입하고 재시작한다. 두 토큰이 모두 허용되며 콘솔의 연결과 기록 패널에 교체 진행 중으로 표시된다.
2. 관리 자동화와 운영자를 새 토큰으로 바꾼다. 이전 토큰을 쓴 실패 시도는 `admin_auth_failed`로 감사 기록에 남는다.
3. 새 토큰을 `RELAYGUARD_ADMIN_TOKEN`으로 옮기고 `_NEXT`를 지운 뒤 재시작한다.

토큰 유출이 의심되면 1단계 없이 바로 교체하고 재시작한다.

## 원본 인증 헤더

Bearer가 아닌 API 키 헤더를 쓰는 서비스는 헤더 이름과 접두어를 지정한다. 값은 요청마다 서버에서 주입하며 클라이언트가 보낸 같은 이름의 헤더는 전달하지 않는다.

```bash
export RELAYGUARD_UPSTREAM_AUTH_HEADER='X-API-Key'
export RELAYGUARD_UPSTREAM_AUTH_SCHEME='none'
relayguard check-config
```

## 모니터링: 지표와 알림

`/metrics`는 Prometheus 형식으로 키 상태, 결정·사유별 요청 수, 승인한 응답 바이트, 관리자 인증 실패, 감사 기록 수와 증분 검증 결과를 제공한다. 값은 DB에서 계산하므로 워커가 여러 개여도 같다. 수집용으로는 관리자 토큰 대신 `RELAYGUARD_METRICS_TOKEN`을 쓴다. 이 토큰은 `/api/*`에 접근할 수 없다.

```yaml
scrape_configs:
  - job_name: relayguard
    scrape_interval: 30s
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/relayguard-metrics-token
    static_configs:
      - targets: ['relayguard.internal:8810']
```

요청 수 집계는 감사 테이블을 훑으므로 기록이 많으면 수집 간격을 30초 이상으로 둔다. `RELAYGUARD_ALERT_WEBHOOK_URL`을 설정하면 누적 한도 소진, 폐기된 키 사용, 관리자 인증 실패, 저장소·감사 실패, 키별 거부 급증을 JSON으로 보낸다. Slack과 호환되는 `text` 필드도 포함한다. 알림은 프로세스 안의 제한된 큐에서 3초 제한 시간으로 한 번만 시도하며 재시도와 리디렉션은 없다. 알림 실패가 게이트웨이 결정을 바꾸지 않으므로 중요한 감시는 `/metrics`로도 함께 한다. 웹훅 수신처는 키, 토큰, 쿼리 값, 본문을 받지 않는다. 컨테이너의 외부 통신 정책에 웹훅 호스트를 허용해야 한다.

## TLS와 네트워크 경계

기본 바인딩은 `127.0.0.1`이다. `serve --tls-cert ... --tls-key ...`로 인증서를 지정하면 Uvicorn이 직접 TLS를 종료하며 실제 접속 IP를 사용할 수 있다. 데모 모드 외의 upstream은 항상 HTTPS다. 클라이언트 측 HTTP를 외부 네트워크에 그대로 노출하지 않는다.

```bash
relayguard serve --host 0.0.0.0 --port 8810 \
  --tls-cert /run/tls/fullchain.pem --tls-key /run/tls/privkey.pem
```

컨테이너에서 직접 TLS를 사용할 때는 인증서와 개인 키를 읽기 전용으로 마운트하고 이미지 뒤에 이 명령을 지정한다. 비루트 사용자에게 키 읽기 권한을 부여하고, 외부 포트 노출은 방화벽 정책과 함께 설정한다.

일반 L7 reverse proxy에서 TLS를 종료하면 RelayGuard가 보는 peer는 프록시다. 이 경우 IP 정책은 최종 클라이언트를 구분하지 못한다. 본 프로젝트는 `X-Forwarded-For`를 의도적으로 신뢰하지 않으므로 다음 중 하나를 선택한다.

1. 직접 TLS와 방화벽으로 peer IP를 보존한다.
2. 프록시가 최종 클라이언트의 IP/mTLS 정책을 검증하고 RelayGuard에는 프록시 네트워크만 허용한다. `/api/*` 관리 경로는 별도의 관리 네트워크나 인증 계층으로 제한한다.

다른 ASGI 실행기로 시작할 때도 proxy-header 신뢰를 임의로 켜지 않는다. `/api/*`와 `/proxy/*`는 서로 다른 토큰을 사용하지만 같은 포트에 있다. 앞단에서 익명 요청의 호출률, 헤더 크기, 연결 수와 TLS 정책을 제한한다. CLI는 access log를 끈다. 프록시/LB 로그도 Authorization, 쿼리 값, 본문을 기록하지 않도록 설정한다.

## 저장소, 감사, 장애

새 DB는 파일 권한 `0600`으로 생성하고 CLI는 `umask 077`을 적용한다. 기존 DB와 디렉터리의 권한을 자동으로 재설정하지 않는다. 배포 전 소유자와 권한을 확인한다. SQLite 파일을 여러 호스트의 공유 NFS에 두지 않는다.

분당 예산 테이블은 키마다 현재와 직전 분만 남기고 오래된 행을 자동으로 지운다. 누적 사용량은 키 행에 따로 보관하므로 지워도 줄지 않는다. 감사 테이블의 자동 삭제나 외부 보관 서비스는 구현하지 않았다. 이벤트 필터용 인덱스는 시작 시 만들어지며, 기록이 많은 기존 DB에서는 첫 시작이 조금 오래 걸릴 수 있다. 디스크 사용량과 503 증가를 모니터링한다. 감사 JSON과 head hash를 정기적으로 독립 저장소에 보관한다. SQLite Online Backup API 또는 정지 후 백업을 사용한다. 실행 중 `.db` 파일 하나만 복사하면 WAL의 최신 상태가 빠질 수 있다.

조작되거나 일부만 복원된 체인은 시작 시 검증에 실패한다. 실행 중인 프로세스는 마지막으로 검증한 지점을 메모리에 기억하므로, 그 뒤 기록이 삭제되거나 앞부분이 다시 작성되면 개요·`/metrics`·전체 검증에서 실패로 보고한다. 재시작 후에는 이 기준점이 사라진다. 원본을 보존하고 외부 체크포인트와 비교한다. 과거의 정상 DB 전체를 복원하면 검증은 통과할 수 있으며 해지 상태와 사용량도 되돌아갈 수 있으므로, 복구 후 원본 제공자 토큰을 회전하고 릴레이 키를 재발급하는 절차가 필요하다.

호출 예약 후 실패나 클라이언트 연결 종료는 예산을 반환하지 않는다. 응답 승인 이후 감사 저장 실패도 예산을 소비할 수 있다. 보수적으로 차단하는 선택이며, 최종 도착량과 예산 사용량의 완전한 일치는 보장하지 않는다.

`/healthz`는 프로세스 생존 여부다. `/readyz`는 기존 DB와 필요한 테이블을 확인하고 쓰기 트랜잭션을 획득한 뒤 롤백한다. 쓰기 잠금 대기는 100ms이며 경합 중에는 503이 나올 수 있다. provider 상태와 전체 감사 체인 검증은 포함하지 않는다. SQLite 작업은 작업 스레드로 넘기지만 DB 쓰기는 직렬화되며 단일 호스트를 전제로 한다.

## v0.2.0으로 업그레이드

1. 기존 버전의 **모든 워커와 컨테이너를 중지**한다. 구버전과 신버전이 같은 DB를 동시에 사용하면 구버전이 누적 카운터를 갱신하지 않으므로 혼용하지 않는다.
2. 중지된 DB 파일과 남아 있는 `-wal`, `-shm` 파일을 같은 백업 디렉터리에 보관한다. 실행 중인 DB는 SQLite Online Backup API를 사용한다. 백업에도 키 해시, IP, 감사 메타데이터가 있으므로 접근을 제한한다.
3. v0.2.0을 기존 DB 경로로 시작한다. 최초 시작에서 단일 트랜잭션으로 누적 카운터를 추가하고 기존 분당 예산의 합을 반영한다. 여러 신버전 워커가 동시에 시작해도 한 번만 수행한다. 과거 예산을 수동 삭제했다면 삭제된 사용량은 복원할 수 없다.
4. `/readyz`, 관리자 콘솔의 감사 검증, 기존 키의 사용량을 확인한다. 기존 키는 누적 한도가 자동으로 생기지 않는다. 새 키에 `max_total_requests`, `max_total_bytes`를 설정하고 기존 키를 폐기한다.

Python 배포의 정지 상태 백업 예시다. 경로는 실제 배포에 맞춘다.

```bash
# 먼저 모든 RelayGuard 프로세스를 중지한다.
umask 077
python - <<'PY'
from pathlib import Path
import shutil
source = Path('.relayguard/relayguard.db')
backup = Path('.relayguard/backup-before-0.2.0')
backup.mkdir(mode=0o700, exist_ok=False)
if not source.is_file():
    raise SystemExit('Database not found; no backup created')
for suffix in ('', '-wal', '-shm'):
    file = Path(str(source) + suffix)
    if file.exists():
        shutil.copy2(file, backup / file.name)
PY
```

Docker 볼륨도 모든 컨테이너를 중지한 상태에서 백업하거나 Online Backup API를 사용한다. 새 버전에서 사용한 DB에 구버전을 연결하는 롤백은 권장하지 않는다. 백업 전체를 복원하면 폐기 상태와 사용량이 과거로 돌아간다. 복원이 필요하면 원본 토큰 회전과 릴레이 키 재발급을 함께 수행한다.

## 운영 전 확인할 실제 조건

- upstream이 키에 허용된 경로에서 올바른 객체/테넌트 권한을 적용하는가?
- debug/echo/토큰 발급/관리/RPC 경로가 허용 규칙에 포함되지 않았는가?
- 외부 연동이 원본 제공자 토큰을 갖고 게이트웨이를 우회할 수 없는가?
- 허용된 데이터의 민감도에 맞게 분당 바이트와 응답 크기를 정했는가?
- TLS, 실제 peer 또는 프록시의 IP 통제, 관리자 경로 제한이 적용되는가?
- 정상 부하와 장애 상황에서 SQLite 지연/디스크 여유를 측정했는가?

이 버전의 테스트는 기능과 보안 경계 검증이다. 처리량 수치, 다중 리전 가용성, 독립 침투 테스트 결과를 제공하지 않는다.
