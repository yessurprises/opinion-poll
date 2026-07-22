-- pg_cron으로 30초마다 synthesize Edge Function 호출
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 프로젝트 URL / service_role 키는 Vault에 보관 (마이그레이션에 시크릿을 커밋하지 않기 위함)
-- 배포 후 1회, SQL editor에서 아래를 project 값으로 바꿔 실행:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>', 'service_role_key');
-- (README.md 배포 절차 참고)

select cron.schedule(
  'synthesize-30s',
  '30 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1) || '/functions/v1/synthesize',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
