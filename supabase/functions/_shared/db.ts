import { createClient } from "jsr:@supabase/supabase-js@2";

// 모든 Edge Function은 service_role 키로 접근한다 (RLS는 anon/authenticated만 차단).
export function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
}

export function checkAdminKey(req: Request, body: Record<string, unknown>): boolean {
  const expected = Deno.env.get("ADMIN_KEY");
  if (!expected) return false;
  const provided = req.headers.get("x-admin-key") ?? (body.admin_key as string | undefined);
  return provided === expected;
}
