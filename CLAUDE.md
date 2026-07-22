# CLAUDE.md — 실시간 의견수렴·AI 종합 시스템 (v2 단순화)

행사용 웹앱. 참가자 250명이 QR로 접속해 폴 응답·질문을 제출하고, AI가 실시간 종합해 대형 스크린에 표출한다. 운영자 1인이 모바일로 제어한다.

> 이 문서는 원래 `D:\Epic\CLAUDE.md`에 있던 스펙을 2026-07-22 이 프로젝트 폴더로 옮긴 것이다. 소스 원본 위치: `D:\Epic\__프로젝트\opinion-poll`.
> **AI 모델 변경**: 전역 설정상 Gemini 텍스트 호출이 크레딧 소진으로 죽어 있어, 아래 "AI: Gemini flash" 대신 **OpenAI `gpt-4o-mini`**로 구현했다 (호출 지점 2곳: 질문 심사 `screenQuestion`, 종합 `synthesizeOpinions` — `supabase/functions/_shared/openai.ts`). Gemini 크레딧이 복구되면 이 파일만 교체하면 된다.

## 단순화 원칙 (v1 대비 변경 근거)

- 움직이는 부품 최소화: webhook 없음, websocket 없음, 별도 벤더 없음
- 폴백을 만들지 않는다 — **가장 단순한 방식(폴링)을 유일한 경로로** 쓴다
- 자동화된 예외 처리보다 **운영자 수동 스위치** (현장에 사람이 있다)
- 이번 행사에 필요 없는 유연성은 구현하지 않는다

## 스택 (고정, 2개 부품)

- 프론트: 단일 `index.html` (vanilla JS). `?role=guest|screen|admin` 3뷰 분기. CDN 금지, 전부 인라인
- 백엔드: **Supabase 하나로 통일** — Postgres + Edge Functions + pg_cron. Cloudflare 사용 안 함
- 모든 쓰기는 Edge Function `api` 하나를 거친다 (직접 insert 없음). 읽기는 3초 폴링으로 `state` 함수 하나만 호출
- Realtime(websocket) 사용 안 함. 재접속·구독 관리 코드 자체가 없음
- AI: OpenAI `gpt-4o-mini` (원 스펙은 Gemini flash — 위 안내 참고). 호출 지점은 딱 2곳 (질문 심사, 종합)
- 대상 브라우저: 카톡 인앱, iOS Safari, Android Chrome. localStorage 금지

## 데이터 모델 (5테이블)

```sql
sessions  (id, code unique, title, active_view text default 'idle',  -- idle|poll|qna|synthesis
           active_poll_id, ai_screening bool default true)
polls     (id, session_id, type text,  -- choice|wordcloud|open  (scale 없음: 1~5 choice로 대체)
           question, options jsonb, is_active bool)
votes     (id, poll_id, token, value jsonb, created_at, unique(poll_id, token))
questions (id, session_id, token, nickname, body, likes int default 0,
           status text,        -- live|review|hidden|answered  (screening 상태 없음: 심사는 동기 처리)
           liked_by jsonb default '[]', created_at)
syntheses (id, session_id, clusters jsonb, lines jsonb, opinion_count, created_at)
```

- opinions 테이블 없음: 자유 의견은 `type='open'` 폴의 votes로 저장. 테이블 하나 삭감
- question_likes 테이블 없음: `liked_by` jsonb 배열로 중복 방지 (250명 규모에서 충분)
- token: 최초 진입 시 `api`가 발급, URL fragment로 유지

## 쓰기 API — Edge Function `api` 하나 (action 파라미터 분기)

```
join / vote / ask / like / admin_set_view / admin_poll_toggle /
admin_question_status / admin_synthesize / admin_ai_toggle / admin_export
```

- `ask`(질문 제출)는 **동기 심사**: 함수 안에서 OpenAI 호출(타임아웃 3초) → 판정 결과 status로 바로 INSERT
  - approve→live / reject→hidden / 애매·타임아웃·오류→review
  - webhook·screening 상태·비동기 레이스 전부 제거. 참가자는 제출 즉시 결과 상태를 앎
  - `sessions.ai_screening=false`(운영자 토글)면 OpenAI 건너뛰고 전건 review — LLM 열화 대응은 자동 서킷브레이커 대신 **admin 스위치 1개**
  - 심사 기준: 욕설·혐오·인신공격·광고·개인정보 노출만 reject. 비판적 질문은 approve가 기본
- `admin_*`는 admin_key 검증. RLS는 "직접 테이블 접근 차단 + 함수만 허용"으로 단순화

## 읽기 — 폴링 하나

- `state?code=X&role=Y` 함수: 역할에 맞는 현재 상태 JSON 반환 (활성 폴+집계, live 질문 목록, 최신 종합문, review 큐는 admin만)
- guest/screen 3초, admin 2초 간격 폴링. 집계는 쿼리로 즉석 계산 (250명 규모에서 캐시 불필요)
- 부하: 400클라이언트 × 1req/3s ≈ 초당 130회 단순 SELECT — 문제 없음. 문제 생기면 그때 폴링 간격만 늘린다

## AI 종합 (호출 지점 2/2)

- pg_cron 30초마다 Edge Function `synthesize` 호출: 활성 open 폴의 votes 전체 + 직전 종합 → OpenAI 1회 → syntheses INSERT
- 신규 응답 0건이면 skip. "지금 종합" 버튼은 같은 함수 수동 호출. 트리거는 이 두 개뿐 (건수 기반 트리거 없음)
- 출력 JSON: `{"clusters":[{"name","count","share_pct","sentiment","representative_quote"}],"lines":["3줄, 각 60자 이내"]}`
- 제약: 클러스터 2~5개, share_pct 합 100, representative_quote는 입력 원문 그대로
- 실패 시: 그냥 미갱신 (직전 종합문이 화면에 남음). 재시도 로직 없음 — 30초 뒤 cron이 어차피 다시 온다

## 뷰 요구사항

- guest: 진입 3초 내 렌더. active_view 따라 화면 전환(폴 응답 / 질문 작성+live 목록+좋아요 / 대기+종합문). 제출 후 재제출 차단 표시
- screen: 16:9 풀스크린, fade 전환만. 본문 40px+/제목 64px+. 폴 결과(막대/워드클라우드) | Q&A 상위 5 | 종합문. 폴링 실패 시 마지막 화면 유지(빈 화면 금지)
- admin: 모바일 우선. 폴 토글 / review 큐(승인·숨김) / 자동승인분 목록(원터치 숨김) / 표출 전환 4버튼 / 지금 종합 / **AI 심사 on-off** / 접속·응답·대기 카운터
- guest/screen에 live 외 상태 질문 노출 금지

## 수용 기준

1. 폴 제출 → screen 반영 6초 내 (폴링 3초 주기 포함, 250 동시 제출)
2. 질문 제출 → 판정 완료 응답 3.5초 내. 욕설 샘플 20건 전건 hidden/review, 정상 50건 중 review 5건 이하
3. 200건 의견 종합 15초 내
4. OpenAI 강제 오류 시: 질문은 review로 저장, 종합은 미갱신 — 앱 크래시·빈 화면 없음
5. ai_screening off 토글 → 이후 질문 전건 review 확인
6. 카톡 인앱에서 전 기능 동작
7. 부하 스크립트(`scripts/loadtest.mjs`) 400 동접 통과

## 빌드 순서

1. 스키마 + `api`/`state` 함수 골격 + seed
2. 수직 슬라이스: choice 폴 → admin 토글 → guest 응답 → screen 막대그래프 (폴링)
3. wordcloud, open 타입
4. Q&A: ask 동기 심사 + like + admin review 큐 + ai_screening 토글
5. synthesize + pg_cron + screen 종합문 뷰
6. 금칙어(`banned.json`, wordcloud/open 제출 거부), admin_export(CSV)
7. loadtest + 수용 기준 자동화

## 금지사항

- localStorage / websocket / webhook / 외부 CDN / Cloudflare 등 제2 벤더 금지
- 개인정보 필드 생성 금지
- votes 개별 건 AI 호출 금지 (종합은 배치만)
- "나중에 필요할지도 모르는" 설정값·추상화 추가 금지 — 이번 행사 요구만 구현
