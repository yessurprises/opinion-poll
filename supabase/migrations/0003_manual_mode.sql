-- 수기 운영 모드: AI 종합 on/off 스위치 (off면 cron·수동 종합 모두 AI 호출 안 함.
-- 수기 종합문(admin_manual_synthesis)만 게시 가능 — LLM 전면 장애 시 운영자 수동 대응 경로)
alter table sessions add column ai_synthesis boolean not null default true;
