import { getServiceClient } from "./db.ts";
import { synthesizeOpinions, SynthesisResult } from "./openai.ts";

// pg_cron(30초)과 admin_synthesize 수동 호출이 공유하는 종합 로직.
// 활성 open 폴이 없거나 직전 종합 이후 신규 응답이 0건이면 skip.
export async function runSynthesis(sessionId: string): Promise<{ skipped: boolean; reason?: string }> {
  const supabase = getServiceClient();

  const { data: session } = await supabase
    .from("sessions")
    .select("ai_synthesis")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return { skipped: true, reason: "session not found" };
  if (!session.ai_synthesis) return { skipped: true, reason: "ai_synthesis off (manual mode)" };

  const { data: openPoll } = await supabase
    .from("polls")
    .select("id")
    .eq("session_id", sessionId)
    .eq("type", "open")
    .eq("is_active", true)
    .maybeSingle();

  if (!openPoll) return { skipped: true, reason: "no active open poll" };

  const { data: lastSynthesis } = await supabase
    .from("syntheses")
    .select("id, clusters, lines, opinion_count, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: votes } = await supabase
    .from("votes")
    .select("value, created_at")
    .eq("poll_id", openPoll.id)
    .order("created_at", { ascending: true });

  const opinions = (votes ?? []).map((v) => String((v.value as { text?: string })?.text ?? v.value));
  if (opinions.length === 0) return { skipped: true, reason: "no opinions yet" };
  if (lastSynthesis && opinions.length <= lastSynthesis.opinion_count) {
    return { skipped: true, reason: "no new opinions since last synthesis" };
  }

  const previous: SynthesisResult | null = lastSynthesis
    ? { clusters: lastSynthesis.clusters, lines: lastSynthesis.lines }
    : null;

  const result = await synthesizeOpinions(opinions, previous);

  await supabase.from("syntheses").insert({
    session_id: sessionId,
    clusters: result.clusters,
    lines: result.lines,
    opinion_count: opinions.length,
  });

  return { skipped: false };
}
