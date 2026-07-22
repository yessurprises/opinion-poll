import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";
import { runSynthesis } from "../_shared/synthesize_core.ts";

// pg_cron이 30초마다 호출. body 없이 호출되면 active_view='synthesis'이거나
// active open 폴이 있는 모든 세션을 대상으로 종합을 시도한다 (신규 응답 없으면 skip).
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = getServiceClient();

  try {
    let sessionIds: string[];
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.session_id) {
        sessionIds = [body.session_id];
      } else {
        const { data, error } = await supabase.from("sessions").select("id");
        if (error) throw error;
        sessionIds = (data ?? []).map((s) => s.id);
      }
    } else {
      const { data, error } = await supabase.from("sessions").select("id");
      if (error) throw error;
      sessionIds = (data ?? []).map((s) => s.id);
    }

    const results = [];
    for (const sessionId of sessionIds) {
      const result = await runSynthesis(sessionId);
      results.push({ session_id: sessionId, ...result });
    }
    return jsonResponse({ results });
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "internal error", 500);
  }
});
