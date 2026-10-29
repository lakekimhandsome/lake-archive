# Lake Archive

`lakekim.com`과 그 하위 웹사이트를 자동 발견하고, 사라진 사이트도 기록으로 남기는 개인용 인덱스입니다. 프로젝트별 이름·URL·레포지토리 목록은 없습니다. Archive 자신도 일반 DNS/배포 발견 규칙으로 추가됩니다.

## 무료 운영 구조

```text
사용자 → Cloudflare Worker (React 정적 화면 + 조회 API) → D1
매시간 Cloudflare Cron → GitHub workflow_dispatch
                         ↓
                  GitHub Actions / Node.js
                  DNS·배포·GitHub 탐색 + HTTPS 검사 → D1 REST API
```

무거운 탐색은 GitHub Actions에서 실제로 실행합니다. Worker는 긴 탐색 코드를 실행하지 않으므로 Workers Paid의 CPU 설정이 필요 없습니다. 공개 소스 저장소의 표준 Ubuntu runner를 사용하며 유료 플랜을 자동으로 신청하지 않습니다. 무료 한도를 초과하면 실패할 수 있으므로 무제한 무료를 보장하지 않습니다. Cloudflare 계정 내 다른 프로젝트의 사용량과도 한도를 공유합니다.

Cron은 `0 * * * *`(UTC/KST 매시 정각)입니다. GitHub 자체의 `schedule` 대신 Cloudflare에서 `workflow_dispatch`를 호출하므로, GitHub의 공개 저장소 60일 비활동 시 scheduled workflow 중지 정책에 의존하지 않습니다. runner 배정 지연으로 실제 완료 시각은 늦어질 수 있습니다.

## 구조

```text
src/                    React + TypeScript + Tailwind 화면
worker/index.ts         공개 조회·관리 API, Cron 진입점
worker/dispatch.ts      GitHub 작업 실행 요청과 실패 기록
worker/lock.ts          Cron·관리자·runner가 공유하는 D1 잠금
worker/discovery.ts     Cloudflare DNS·Workers Routes/Custom Domains·Pages
worker/github.ts        GitHub 페이지네이션, 명시적 도메인 근거 매칭
worker/probe.ts         HTTPS 상태·HTML title/description/favicon/OG 수집
worker/safety.ts        도메인·URL·공개 IP 제한, DNS 검사
worker/http.ts          timeout, 응답 크기, 관리 API retry
worker/sync.ts          공유 탐색 엔진·UPSERT·오류와 역사 보존
runner/main.ts          Actions/로컬 실행 진입점
runner/d1.ts            parameterized D1 REST adapter
runner/transport.ts     검증한 IP로 HTTPS 연결, 원래 호스트로 TLS 검증
.github/workflows/      공개 로그에 민감한 정보를 출력하지 않는 Actions 작업
migrations/             D1 마이그레이션
tests/                  실제 workerd/D1 + Node runner 경계 테스트
```

## 공개 정책

DNS 레코드는 **발견 근거**일 뿐 공개 승인이 아닙니다. 발견한 모든 호스트는 D1에 보관합니다. 자동 공개의 최초 조건은 다음 둘을 모두 만족하는 것입니다.

1. GitHub API에서 공개임이 확인된 레포가 hostname을 명시하거나, Pages가 해당 공개 레포에 연결되어 있음.
2. HTTPS 요청이 정상 응답(2xx)함.

매칭 근거는 repository `homepage`, 루트 `CNAME`, 루트 `wrangler.toml`/`wrangler.json`/`wrangler.jsonc`의 `route`/`routes`(환경별 설정 포함), `vercel.json`의 `alias`, Pages GitHub 연결입니다. 레포 이름의 유사성은 사용하지 않습니다. 서로 다른 레포가 일치하면 repository는 null입니다. 근거마다 `high` confidence를 기록합니다.

한 번 공개된 사이트의 승인은 역사로 유지합니다. 오프라인·DNS 삭제·배포 설정 삭제 후에도 목록에서 찾을 수 있습니다. **공개 도메인을 내부 서비스로 전환하기 전에 관리자 API에서 `visibility=private`으로 바꾸세요.** 재탐색은 관리자 결정을 덮어쓰지 않습니다. 공개 이력이 없는 내부 서비스는 비공개입니다.

Private 레포는 매칭 근거로 사용하지 않고 소스·이름·설명·경로를 사이트 근거에 저장하지 않습니다. 공개 API는 비공개 사이트, 관리용 필드, 탐색 근거, 오류 내용을 반환하지 않습니다. GitHub 장애 시 DB의 매칭은 보존하면서 확인되지 않은 공개 레포 링크를 숨깁니다. 공개 확인 후 65분이 지나도 링크를 숨깁니다. 공개 레포를 private으로 전환하면 다음 동기화 전까지 이전 링크가 남을 수 있으므로 즉시 숨길 필요가 있으면 관리자로 사이트를 private 처리하세요.

공개 레포가 없는 사이트도 자동 발견·보관됩니다. 공개 목록에 넣으려면 관리자 승인이 필요합니다. 일반적인 공개 프로젝트에서는 GitHub 홈페이지를 실제 사이트로 설정하면 Archive에 별도 등록하지 않아도 됩니다.

## GitHub 탐색 범위

기본 workflow는 실행마다 발급되는 `GITHUB_TOKEN`을 사용해 저장소 소유자의 **공개 레포**를 페이지별 조회합니다. 별도의 장기 GitHub 읽기 토큰 없이 소유한 공개 사이트를 발견합니다. 공개 소스 저장소의 코드·로그·아티팩트에 비공개 탐색 결과를 기록하지 않습니다.

본인이 접근 가능한 private/collaborator/organization 레포 목록까지 조회하려면 선택적으로 `DISCOVERY_GITHUB_TOKEN`을 Actions Secret에 넣으세요. fine-grained PAT에 필요한 레포만 선택하고 Metadata/Contents Read 권한을 부여합니다. 이 경우 `/user/repos`를 사용하며 private 레포는 내용·매칭을 건너뜁니다. 기본 `GITHUB_TOKEN`은 다른 private 레포에 접근할 수 없습니다.

## 로컬 실행과 검증

Node.js 24 LTS와 npm을 권장합니다.

```sh
npm ci
cp .dev.vars.example .dev.vars  # 기존 파일이 있으면 덮어쓰지 마세요.
npm run db:local
npm run dev:worker
```

`http://localhost:8787`에서 화면/API를 제공합니다. Secret 없이도 빈 화면과 조회 API는 확인할 수 있습니다. 프런트엔드 개발 시 별도 터미널에서 `npm run dev`를 실행하면 Vite가 `/api`를 Worker로 proxy합니다.

```sh
npm run check
npx wrangler deploy --dry-run --outdir worker-dist
```

Workers 테스트는 workerd/D1에서, runner transport/D1 adapter 테스트는 Node에서 실행합니다. 외부 관리 API·DNS·원본 사이트는 mock이며 운영 계정에 쓰지 않습니다. 로컬 runner는 셸에 필요한 환경변수를 안전하게 주입한 뒤 `npm run sync`로 실행합니다. `.dev.vars`를 셸에서 `source`하지 마세요. Actions는 GitHub Secrets를 환경변수로 주입합니다.

## Cloudflare 설정

### 계정·D1·도메인

`lakekim.com`이 있는 계정으로 Wrangler에 로그인합니다.

```sh
npx wrangler login
npx wrangler d1 create lake-archive  # 이미 생성했다면 재사용
```

`wrangler.jsonc`의 D1 ID를 실제 ID로 설정합니다. DB ID는 인증 토큰이 아닌 리소스 식별자입니다. Cloudflare 계정 ID를 소스에 쓰지 않으려면 배포 셸의 `CLOUDFLARE_ACCOUNT_ID` 환경변수를 사용합니다.

```sh
npm run db:remote
npm run deploy
```

배포 설정은 React Static Assets, Worker, `archive.lakekim.com` Custom Domain, 매시간 Cron을 함께 생성합니다. 해당 도메인에 다른 서비스나 CNAME이 있으면 먼저 충돌 여부를 확인하세요. Cron 설정 전파에는 최대 15분이 걸릴 수 있습니다. Archive 레포의 homepage 또는 배포 설정이 공개 근거가 되며, 자기 자신을 DB에 수동 삽입하지 않습니다.

### 최소 권한 토큰

Worker 배포용 Wrangler OAuth와 장기 자동 탐색 토큰을 분리합니다.

**`CF_API_TOKEN` — Actions에만 저장**

Cloudflare Custom Token을 만들어 다음 권한을 부여합니다.

| 범위 | 권한 | 수준 |
| --- | --- | --- |
| `lakekim.com` Zone | DNS | Read |
| `lakekim.com` Zone | Workers Routes | Read |
| 해당 Account | Workers Scripts | Read |
| 해당 Account | Cloudflare Pages | Read |
| 해당 Account | D1 | Edit |

D1 Edit은 runner가 D1 REST API에 기록하기 위해 필요합니다. DNS 수정·Worker 배포 권한은 필요 없습니다. Account Resources는 본인 계정, Zone Resources는 `lakekim.com`만 선택하세요. Cloudflare 토큰의 지원 리소스 범위에 따라 D1 권한은 계정 범위입니다. 조직 SSO/정책에 따라 별도 승인이 필요할 수 있습니다.

**`DISPATCH_TOKEN` — Worker Secret에만 저장**

GitHub fine-grained PAT를 만듭니다. Resource owner는 Archive 저장소 소유자, Repository access는 **Archive 저장소 하나만**, Repository permission은 **Actions: Read and write**입니다. 기본 Metadata Read 외에 Contents Write나 다른 저장소 접근은 필요 없습니다. 만료 전 교체하지 않으면 매시간 실행 요청이 실패하므로 관리용 runs에서 확인하세요.

**`ADMIN_TOKEN` — Worker Secret**

`openssl rand -hex 32` 등으로 생성한 32자 이상의 무작위 값입니다. 브라우저에 저장하지 않습니다. 운영 토큰을 소스·채팅·URL query에 넣지 마세요. `.dev.vars`와 `.wrangler/`는 gitignore 대상입니다.

## GitHub Actions 설정

공개 소스 저장소에 코드를 push하고 Actions를 활성화합니다. workflow는 default branch의 `.github/workflows/sync.yml`입니다. Worker의 `SYNC_REPOSITORY`, `SYNC_REF`는 이 저장소/브랜치를 지정하는 운영 설정이며 사이트 수동 등록 목록이 아닙니다.

Actions Secrets:

- `CF_ACCOUNT_ID`
- `CF_ZONE_ID`
- `CF_DATABASE_ID`
- `CF_API_TOKEN`
- `DISCOVERY_GITHUB_TOKEN` — 선택 사항

```sh
gh secret set CF_ACCOUNT_ID
gh secret set CF_ZONE_ID
gh secret set CF_DATABASE_ID
gh secret set CF_API_TOKEN
# 필요할 때만: gh secret set DISCOVERY_GITHUB_TOKEN
```

Worker Secrets:

```sh
npx wrangler secret put DISPATCH_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

Token 값은 명령줄 인수에 넣지 말고 stdin으로 입력하세요. Worker에 탐색용 Cloudflare 토큰을 둘 필요가 없고, Actions에 Worker 관리자 토큰을 둘 필요도 없습니다. Actions의 기본 GitHub 토큰은 최소 Contents Read이며 checkout 후 Git credential을 보존하지 않습니다. 외부 PR/push로 동기화를 실행하지 않고 인증된 workflow_dispatch만 사용합니다.

## 동작 확인·관리 API

```sh
curl https://archive.lakekim.com/api/sites
# ADMIN_TOKEN은 셸 환경변수로 안전하게 주입합니다.
curl --fail-with-body https://archive.lakekim.com/api/admin/runs \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl --fail-with-body -X POST https://archive.lakekim.com/api/admin/sync \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

수동 동기화는 실제 탐색이 끝나기 전에 **202 queued**를 반환합니다. 이후 GitHub Actions 상태와 관리자 `/runs`를 확인하세요. `running`은 요청이 접수되어 runner를 기다리거나 실행 중인 상태입니다. 공개 강제 동기화 API는 없습니다. D1 잠금과 10분 cooldown을 Cron·수동 요청·runner가 공유합니다. Github concurrency도 중복 실행을 직렬화합니다.

인증된 API:

- `GET /api/admin/sites?offset=0`: private을 포함한 100개씩의 기록.
- `PATCH /api/admin/sites`: 이미 발견된 호스트의 `visibility` 변경.
- `GET /api/admin/runs`: 최근 30회 실행과 오류 코드.
- `POST /api/admin/sync`: Actions 실행 요청.

```sh
curl --fail-with-body -X PATCH https://archive.lakekim.com/api/admin/sites \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"hostname":"<발견된 호스트>","visibility":"private"}'
```

`visibility`는 `auto`(기본), `public`(명시적 승인), `private`(항상 숨김)입니다. 관리자 공개 승인도 private 레포 링크를 공개하지 않습니다. Token은 고정 길이 SHA-256 digest로 비교합니다. 공개 API는 60개씩 검색·정렬·필터·페이지 이동을 지원합니다. offline 필터에는 unknown/blocked도 포함하고 배지는 각각 구분합니다.

## 데이터 보존·오류 처리

- Cloudflare DNS는 페이지별 조회하고 A·AAAA·CNAME을 합칩니다. Workers/Pages는 endpoint의 pagination과 단일 페이지 응답을 구분합니다. wildcard에서 가상의 호스트를 만들지 않습니다.
- hostname PK와 UPSERT를 사용하고 사이트 레코드를 삭제하지 않습니다. `first_seen_at`과 관리자 정책을 보존합니다. 발견한 호스트는 느린 GitHub 검사 전에 먼저 기록합니다.
- `last_seen_at`은 관리 API에서 마지막 발견, `last_checked_at`은 HTTPS 검사, `last_online_at`은 마지막 2xx 시각입니다. offline으로 기존 메타데이터를 지우지 않습니다.
- 모든 발견 소스가 성공했는데 호스트가 없을 때만 archived 처리합니다. 재등장하면 해제합니다. 소스 장애 시 과거 archived·매칭을 보수적으로 보존합니다. DNS 관리 조회가 실패하면 원본 검사를 건너뛰고 상태·검사 시각을 유지합니다.
- 관리 API는 본문 포함 12초 timeout, 사이트 probe 전체는 15초입니다. 관리 API 429/5xx는 짧은 Retry-After만 최대 2회 재시도하고 긴 제한은 다음 회차로 넘깁니다. raw upstream 응답·SQL·host·private repo 정보를 Actions 로그에 출력하지 않습니다.
- 엔진은 10분·외부 호출 2,500회, GitHub 조회는 최대 4분·1,200회, Cloudflare 목록은 10,000개, GitHub 레포는 1,000개로 제한합니다. 오래 검사하지 않은 사이트부터 3개씩 처리합니다. 시간/호출 예산 초과는 partial이고 기존 기록은 유지합니다. DB 잠금은 14분 뒤 만료됩니다. 대기 중 lock이 만료된 job은 실행하지 않습니다.
- runner가 비정상 종료되면 running 기록이 남을 수 있지만 잠금 만료 후 다음 Cron에서 재시도합니다. 운영 run 로그는 90일, 사이트 기록은 계속 보관합니다. 마이그레이션은 재실행 가능하며 반복 동기화로 중복 행이 생기지 않습니다.

## 보안·기술적 한계

- 사이트 URL은 `lakekim.com` 또는 정확한 하위 도메인의 HTTPS 443만 허용합니다. IP literal·인증정보·외부 도메인·HTTP·비표준 port를 거부합니다. 리다이렉트는 최대 4회, 매 단계 동일한 검사를 적용합니다.
- DNS 관리 API의 A/AAAA 원본이 private/special IP면 차단합니다. 각 요청 전에 DoH A/AAAA와 runner의 DNS 답을 검사합니다. 하나라도 private·loopback·link-local·특수 IP이면 접속하지 않습니다. Node HTTPS는 **검사한 IP에 직접 연결**하고 원래 hostname으로 SNI·인증서를 검증합니다. 검사 후 DNS 변경으로 연결 대상을 바꾸는 재바인딩을 막습니다. 원본에 Cloudflare/GitHub 인증 헤더·쿠키를 전달하지 않습니다.
- HTML은 압축 해제 후에도 스트리밍 중 512 KiB로 제한합니다. 관리 API 응답은 4 MiB입니다. 메타데이터는 텍스트로 렌더링하고 원격 script를 실행하지 않습니다. 외부 favicon/OG 이미지는 저장하지 않으며 favicon 실패 시 이니셜을 표시합니다.
- WAF·로그인·VPN·외부 SSO·HTTP 전용 사이트는 offline/blocked로 표시될 수 있습니다. 2xx가 앱 전체 정상 동작을 보장하지 않습니다. JS 실행 후 생성되는 title/OG는 수집하지 않습니다.
- Cloudflare Tunnel로 인터넷에 공개한 서비스는 공개 DNS만으로 내부 서비스인지 판별할 수 없으므로 공개 승인 정책을 유지해야 합니다. 이 시스템에 private 네트워크 접근 권한을 추가하지 마세요.
- wildcard-only 배포, 외부 DNS 위임, split DNS, 중첩 monorepo config, Token이 볼 수 없는 리소스는 완전히 열거할 수 없습니다. Workers Builds의 GitHub 연결은 수집하지 않고 public repo homepage/config로 보완합니다.
- 대규모 계정은 GitHub/Cloudflare API rate limit·D1 무료 한도에 걸릴 수 있습니다. 계속 partial이 발생하면 조회 범위를 줄이거나 cursor/cache로 나눠야 합니다. D1 무료 한도는 계정 전체 읽기 500만 행/일, 쓰기 10만 행/일, 저장 5GB입니다. 사용량은 D1 대시보드에서 확인하세요.
- 무료 Actions 러너 조건은 **public 소스 repo + 표준 runner**입니다. private 저장소로 바꾸거나 larger runner를 사용하면 무료 조건이 달라집니다. Actions artifact/cache에 탐색 결과를 업로드하지 않습니다.

## 공식 문서

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 query REST API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [DNS Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/)
- [Workers Routes API](https://developers.cloudflare.com/api/resources/workers/subresources/routes/methods/list/)
- [Workers Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/)
- [Pages Projects API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/)
- [GitHub repository API](https://docs.github.com/en/rest/repos/repos)
- [GitHub contents API](https://docs.github.com/en/rest/repos/contents)
- [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
