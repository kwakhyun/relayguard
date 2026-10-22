# 배포와 운영

먼저 로컬 `relayguard demo`로 흐름을 확인한다. 배포 대상은 운영자가 제어하는 연동 앱과 API다. 제삼자가 고정해 놓은 SaaS 간 OAuth 연결을 이 프로젝트가 자동으로 가로채거나 교체하지 않는다.

## 설정

| 변수 | 의미 |
| --- | --- |
| `RELAYGUARD_UPSTREAM_URL` | HTTPS origin. 경로, 사용자 정보, 쿼리, fragment 금지. 예: `https://api.example.com` |
| `RELAYGUARD_UPSTREAM_TOKEN` | 제공자의 최소 권한 Bearer 토큰. 운영 비밀 저장소에서 주입 |
| `RELAYGUARD_ADMIN_TOKEN` | 최소 32자의 고엔트로피 관리자 비밀. `relayguard generate-admin-token`으로 생성 |
| `RELAYGUARD_DB` | 로컬 SQLite 파일. 기본값 `.relayguard/relayguard.db` |

API 계정이 여러 개면 격리된 게이트웨이 배포를 나눈다. 프로세스를 재시작해야 환경변수의 토큰 교체가 적용된다. 원본 제공자의 OAuth refresh는 자동 수행하지 않는다. Python CLI는 `.env`를 자동으로 읽지 않는다. Docker Compose는 프로젝트의 `.env`를 읽어 `compose.yaml`의 변수에 적용한다.

## Docker 이미지로 실행

공개 이미지 `ghcr.io/kwakhyun/relayguard:0.1.1`은 `linux/amd64`와 `linux/arm64`용이다. Docker 로그인 없이 내려받을 수 있다. 다음 예제의 URL과 원본 토큰을 실제 값으로 바꾸고, 생성한 관리자 토큰을 안전하게 보관한다.

```bash
export RELAYGUARD_UPSTREAM_URL='https://your-api.example.com'
export RELAYGUARD_UPSTREAM_TOKEN='replace-with-provider-token'
export RELAYGUARD_ADMIN_TOKEN="$(docker run --rm \
  ghcr.io/kwakhyun/relayguard:0.1.1 relayguard generate-admin-token)"

docker run -d --name relayguard --restart unless-stopped \
  -p 127.0.0.1:8810:8810 \
  --env RELAYGUARD_UPSTREAM_URL --env RELAYGUARD_UPSTREAM_TOKEN \
  --env RELAYGUARD_ADMIN_TOKEN \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount type=volume,source=relayguard-data,target=/data \
  ghcr.io/kwakhyun/relayguard:0.1.1

curl --fail http://127.0.0.1:8810/healthz
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

호스트에는 `127.0.0.1:8810`만 노출하며 보안 옵션과 영속 볼륨은 Compose 파일에 포함되어 있다. `docker compose down`은 컨테이너를 제거하고 DB 볼륨은 유지한다. `down --volumes`는 DB까지 삭제하므로 데이터 초기화가 필요할 때만 사용한다.

## 이미지 선택과 직접 빌드

[GHCR 패키지](https://github.com/users/kwakhyun/packages/container/package/relayguard)에서 버전 태그 `0.1.1`, 최신 릴리스 `latest`, 소스 커밋의 `sha-<commit>` 태그를 확인할 수 있다. 운영에서는 검증한 digest로 이미지를 고정한다.

```bash
docker pull ghcr.io/kwakhyun/relayguard:0.1.1
docker image inspect ghcr.io/kwakhyun/relayguard:0.1.1 \
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

감사/예산 테이블 자동 삭제나 외부 보관 서비스는 구현하지 않았다. 디스크 사용량과 503 증가를 모니터링한다. 감사 JSON과 head hash를 정기적으로 독립 저장소에 보관한다. SQLite Online Backup API 또는 정지 후 백업을 사용한다. 실행 중 `.db` 파일 하나만 복사하면 WAL의 최신 상태가 빠질 수 있다.

조작되거나 일부만 복원된 체인은 시작 시 검증에 실패한다. 원본을 보존하고 외부 체크포인트와 비교한다. 과거의 정상 DB 전체를 복원하면 검증은 통과할 수 있으며 해지 상태와 사용량도 되돌아갈 수 있으므로, 복구 후 원본 제공자 토큰을 회전하고 릴레이 키를 재발급하는 절차가 필요하다.

호출 예약 후 실패나 클라이언트 연결 종료는 예산을 반환하지 않는다. 응답 승인 이후 감사 저장 실패도 예산을 소비할 수 있다. 보수적으로 차단하는 선택이며, 최종 도착량과 예산 사용량의 완전한 일치는 보장하지 않는다.

## 운영 전 확인할 실제 조건

- upstream이 키에 허용된 경로에서 올바른 객체/테넌트 권한을 적용하는가?
- debug/echo/토큰 발급/관리/RPC 경로가 허용 규칙에 포함되지 않았는가?
- 외부 연동이 원본 제공자 토큰을 갖고 게이트웨이를 우회할 수 없는가?
- 허용된 데이터의 민감도에 맞게 분당 바이트와 응답 크기를 정했는가?
- TLS, 실제 peer 또는 프록시의 IP 통제, 관리자 경로 제한이 적용되는가?
- 정상 부하와 장애 상황에서 SQLite 지연/디스크 여유를 측정했는가?

이 버전의 테스트는 기능과 보안 경계 검증이다. 처리량 수치, 다중 리전 가용성, 독립 침투 테스트 결과를 제공하지 않는다.
