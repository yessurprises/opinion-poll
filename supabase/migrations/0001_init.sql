-- 실시간 의견수렴·AI 종합 시스템 v2 — 초기 스키마 (5테이블)
create extension if not exists pgcrypto;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  title text not null,
  active_view text not null default 'idle' check (active_view in ('idle', 'poll', 'qna', 'synthesis')),
  active_poll_id uuid,
  ai_screening boolean not null default true,
  created_at timestamptz not null default now()
);

create table polls (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  type text not null check (type in ('choice', 'wordcloud', 'open')),
  question text not null,
  options jsonb not null default '[]',
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

alter table sessions
  add constraint sessions_active_poll_fk foreign key (active_poll_id) references polls(id) on delete set null;

create table votes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  token text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  unique (poll_id, token)
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  token text not null,
  nickname text,
  body text not null,
  likes integer not null default 0,
  status text not null default 'review' check (status in ('live', 'review', 'hidden', 'answered')),
  liked_by jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table syntheses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  clusters jsonb not null default '[]',
  lines jsonb not null default '[]',
  opinion_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index idx_polls_session on polls(session_id);
create index idx_polls_session_active on polls(session_id, is_active);
create index idx_votes_poll on votes(poll_id);
create index idx_questions_session_status on questions(session_id, status);
create index idx_syntheses_session_created on syntheses(session_id, created_at desc);

-- RLS: 직접 테이블 접근 차단. Edge Function은 service_role 키로 RLS를 우회해 접근.
-- anon/authenticated 대상 정책을 만들지 않아 기본적으로 전체 차단된다.
alter table sessions enable row level security;
alter table polls enable row level security;
alter table votes enable row level security;
alter table questions enable row level security;
alter table syntheses enable row level security;

revoke all on sessions, polls, votes, questions, syntheses from anon, authenticated;

-- seed: 데모 세션 1개
insert into sessions (code, title, active_view, ai_screening)
values ('DEMO', '데모 행사', 'idle', true);
