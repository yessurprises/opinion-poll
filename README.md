# 실시간 의견수렴·AI 종합 시스템

스펙: [CLAUDE.md](./CLAUDE.md). 소스 원본 위치: `D:\Epic\__프로젝트\opinion-poll` (git 저장소).

## 구조

```
public/index.html              프론트 전체 (?role=guest|screen|admin)
supabase/migrations/           DB 스키마 + pg_cron 등록
supabase/functions/api/        쓰기 전용 (join/vote/ask/like/admin_*)
supabase/functions/state/      읽기 전용 폴링 (role별 상태 JSON)
supabase/functions/synthesize/ AI 종합 (pg_cron 30초 + admin_synthesize가 공유)
supabase/functions/_shared/    openai.ts / db.ts / moderation.ts / banned.json
scripts/loadtest.mjs           400 동접 부하 테스트
```

## 배포 절차

### 0. 사전 준비
- Supabase 프로젝트 (project ref, access token)
- OpenAI API 키 (`gpt-4o-mini` 사용 가능한 키)
- Node 18+ (Supabase CLI는 `npx supabase`로 실행, 전역 설치 불필요)

### 1. 로그인 & 링크
```bash
export SUPABASE_ACCESS_TOKEN=<personal-access-token>
npx supabase link --project-ref <project-ref>
```

### 2. DB 마이그레이션
```bash
npx supabase db push
```
`0002_cron.sql`은 pg_cron/pg_net만 켜고 실제 스케줄 등록은 시크릿이 필요하므로, push 후 Supabase 대시보드 SQL Editor에서 1회 실행:
```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
```
(service-role-key는 대시보드 Project Settings → API에서 확인)

### 3. 시크릿 설정
```bash
npx supabase secrets set OPENAI_API_KEY=sk-...
npx supabase secrets set ADMIN_KEY=<운영자용 임의 문자열>
```
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`는 Edge Function 런타임이 자동 주입하므로 별도 설정 불필요.

### 4. Edge Functions 배포
```bash
npx supabase functions deploy api --no-verify-jwt
npx supabase functions deploy state --no-verify-jwt
npx supabase functions deploy synthesize
```
`api`/`state`는 참가자가 인증 없이 호출하므로 `--no-verify-jwt`. `synthesize`는 pg_cron이 service-role 키(=유효 JWT)로만 호출하므로 기본값(JWT 검증 켜짐) 유지.

### 5. 프론트 배포
`public/index.html` 상단의
```js
const FUNCTIONS_URL = "https://__SUPABASE_PROJECT_REF__.supabase.co/functions/v1";
```
를 실제 project ref로 교체한 뒤, Supabase Storage 공개 버킷에 업로드 (별도 벤더 없이 Supabase 하나로 유지하기 위함):
```bash
npx supabase storage buckets create site --public
npx supabase storage cp public/index.html ss:///site/index.html --content-type text/html
```
버킷 공개 URL(`https://<project-ref>.supabase.co/storage/v1/object/public/site/index.html`)에 아래 쿼리를 붙여 사용:
- 참가자: `?role=guest&code=DEMO`
- 스크린: `?role=screen&code=DEMO`
- 운영자: `?role=admin&code=DEMO&admin_key=<ADMIN_KEY>`

### 6. 세션 코드
`0001_init.sql`이 `code='DEMO'` 세션을 시드한다. 실제 행사는 SQL Editor에서:
```sql
insert into sessions (code, title) values ('행사코드', '행사명');
```

## 재배포 (수정 후)
- 스키마 변경: `npx supabase db push`
- 함수 코드 변경: `npx supabase functions deploy <함수명>` (플래그는 위와 동일하게 유지)
- 프론트 변경: `public/index.html` 재업로드 (storage cp 재실행, 덮어쓰기됨)

## 부하 테스트
```bash
node scripts/loadtest.mjs https://<project-ref>.supabase.co/functions/v1 DEMO 400
```
사전에 admin으로 choice 폴을 하나 켜둬야 한다. 수용 기준: 400건 무손실 제출 + screen 반영 6초 이내.

## AI 모델 관련
프로젝트 스펙(CLAUDE.md) 원문은 Gemini flash를 지정하지만, 현재는 OpenAI `gpt-4o-mini`로 구현되어 있다 (Gemini 텍스트 크레딧 소진 이슈, 상단 CLAUDE.md 안내 참고). 전환하려면 `supabase/functions/_shared/openai.ts` 하나만 교체하면 된다 (호출부는 `screenQuestion`/`synthesizeOpinions` 두 함수로 이미 분리돼 있음).
