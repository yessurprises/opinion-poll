# 실시간 의견수렴·AI 종합 시스템

스펙: [CLAUDE.md](./CLAUDE.md). 소스 원본 위치: `D:\Epic\__프로젝트\opinion-poll` (git, GitHub `yessurprises/opinion-poll`).

## 배포 현황 (2026-07-22)

| 부품 | 위치 | 재배포 방법 |
|---|---|---|
| DB (Postgres) | Supabase 프로젝트 `opinion-poll` (`gocfxeoqbdfmpdpomunm`, ap-northeast-2) | `npx supabase db push` |
| Edge Functions api/state/synthesize | 같은 프로젝트 | `npx supabase functions deploy <이름>` (api/state는 `--no-verify-jwt`) |
| pg_cron 30초 종합 | `cron.job` `synthesize-30s` (Vault에 project_url/service_role_key) | 마이그레이션 0002 참고 |
| 프론트 `docs/index.html` | GitHub Pages (`yessurprises/opinion-poll`, main 브랜치 `/docs`) | 커밋 후 `git push` |

접속 URL (세션코드 DEMO 기준):
- 참가자: `https://yessurprises.github.io/opinion-poll/?role=guest&code=DEMO`
- 스크린: `https://yessurprises.github.io/opinion-poll/?role=screen&code=DEMO`
- 운영자: `https://yessurprises.github.io/opinion-poll/?role=admin&code=DEMO&admin_key=<ADMIN_KEY>`

시크릿 (Supabase Edge Function secrets에 설정):
- `ADMIN_KEY` — 설정 완료 (값은 운영자만 보관)
- `OPENAI_API_KEY` — **미설정**. 없어도 전 기능 동작(아래 수기 모드), 설정하면 AI 심사·종합 활성화: `npx supabase secrets set OPENAI_API_KEY=sk-...`

> 왜 GitHub Pages인가: Supabase는 피싱 방지 정책으로 기본 도메인(Storage·Edge Functions)에서 HTML 서빙 시 Content-Type을 text/plain으로 강제한다. 정적 파일 1개는 GitHub Pages에서 서빙하고, 데이터·로직은 전부 Supabase에 유지.

## 수기 운영 모드 (LLM 전면 장애 대응)

AI가 아예 죽어도 행사 진행 가능:
- **질문 심사**: admin "AI 자동심사" off → 전건 review 큐 → 운영자가 승인/숨김. (OpenAI 키 미설정·타임아웃·오류 시에도 자동으로 review 처리)
- **종합**: admin "AI 자동종합" off → cron·수동 종합 모두 AI 호출 안 함. "수기 종합문" 입력란에 줄바꿈으로 구분해 작성 → "수기 종합 게시" → screen/guest에 즉시 표출. AI를 다시 켜도 신규 응답이 없는 한 수기 종합문이 유지된다.

## 처음부터 재배포하는 절차 (새 프로젝트 기준)

1. `export SUPABASE_ACCESS_TOKEN=...` 후 `npx supabase link --project-ref <ref>`
2. `npx supabase db push`
3. 대시보드 SQL Editor에서 Vault 시크릿 1회 등록:
   ```sql
   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
   select vault.create_secret('<service-role-key>', 'service_role_key');
   ```
4. `npx supabase secrets set ADMIN_KEY=<임의 문자열> OPENAI_API_KEY=sk-...`
5. `npx supabase functions deploy api --no-verify-jwt` / `state --no-verify-jwt` / `synthesize`
6. `docs/index.html`의 `FUNCTIONS_URL`을 새 ref로 교체 → 커밋 → push (GitHub Pages 자동 반영)
7. 세션 생성: SQL Editor에서 `insert into sessions (code, title) values ('행사코드', '행사명');`

## 부하 테스트

```bash
node scripts/loadtest.mjs https://gocfxeoqbdfmpdpomunm.supabase.co/functions/v1 DEMO 400
```
사전에 admin으로 choice 폴을 하나 켜둬야 한다. 수용 기준: 400건 무손실 제출 + screen 반영 6초 이내.

## AI 모델 관련

프로젝트 스펙(CLAUDE.md) 원문은 Gemini flash를 지정하지만, 현재는 OpenAI `gpt-4o-mini`로 구현 (Gemini 텍스트 크레딧 소진). 전환하려면 `supabase/functions/_shared/openai.ts` 하나만 교체 (호출부는 `screenQuestion`/`synthesizeOpinions` 두 함수로 분리돼 있음).
