-- 재제출 정책 변경: choice는 재투표(기존 표 변경), wordcloud/open은 복수 제출 허용
-- unique(poll_id, token) 제약 제거 — choice 1인 1표는 api에서 upsert로 보장
alter table votes drop constraint votes_poll_id_token_key;
create index idx_votes_poll_token on votes(poll_id, token);
