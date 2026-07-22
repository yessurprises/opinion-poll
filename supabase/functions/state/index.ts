import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";

type Role = "guest" | "screen" | "admin";

function aggregateChoice(votes: { value: unknown }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of votes) {
    const key = String((v.value as { option?: string })?.option ?? v.value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function aggregateWordcloud(votes: { value: unknown }[]): { word: string; count: number }[] {
  const counts: Record<string, number> = {};
  for (const v of votes) {
    const text = String((v.value as { text?: string })?.text ?? v.value).trim();
    if (!text) continue;
    counts[text] = (counts[text] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([word, count]) => ({ word, count }))
    // count 동률일 때 DB 조회 순서(비결정적)에 기대지 않도록 단어 사전순을 2차 기준으로 고정.
    // 그래야 투표 데이터가 그대로면 폴링마다 결과 배열이 완전히 동일해 화면이 불필요하게 재배치되지 않는다.
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, 50);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const role = (url.searchParams.get("role") ?? "guest") as Role;
  if (!code) return errorResponse("missing code", 400);
  if (!["guest", "screen", "admin"].includes(role)) return errorResponse("invalid role", 400);

  if (role === "admin") {
    const expected = Deno.env.get("ADMIN_KEY");
    const provided = req.headers.get("x-admin-key") ?? url.searchParams.get("admin_key");
    if (!expected || provided !== expected) return errorResponse("unauthorized", 401);
  }

  const supabase = getServiceClient();

  try {
    const { data: session, error: sessionErr } = await supabase
      .from("sessions")
      .select("id, title, active_view, active_poll_id, ai_screening, ai_synthesis")
      .eq("code", code)
      .maybeSingle();
    if (sessionErr) throw sessionErr;
    if (!session) return errorResponse("session not found", 404);

    let activePoll: Record<string, unknown> | null = null;
    let activePollVotes: { id: string; value: unknown; created_at: string }[] = [];
    if (session.active_poll_id) {
      const { data: poll, error: pollErr } = await supabase
        .from("polls")
        .select("id, type, question, options")
        .eq("id", session.active_poll_id)
        .maybeSingle();
      if (pollErr) throw pollErr;
      if (poll) {
        const { data: votes, error: votesErr } = await supabase
          .from("votes")
          .select("id, value, created_at")
          .eq("poll_id", poll.id)
          .order("created_at", { ascending: false });
        if (votesErr) throw votesErr;

        let results: unknown;
        if (poll.type === "choice") results = aggregateChoice(votes ?? []);
        else if (poll.type === "wordcloud") results = aggregateWordcloud(votes ?? []);
        else results = { opinion_count: (votes ?? []).length };

        activePoll = { ...poll, results, total_votes: (votes ?? []).length };
        if (role === "admin") {
          // 관리자 화면에서 개별 응답을 원터치로 삭제할 수 있도록 원본 목록도 함께 내려준다.
          activePollVotes = (votes ?? []).map((v) => ({ id: v.id, value: v.value, created_at: v.created_at }));
        }
      }
    }

    const { data: liveQuestions, error: questionsErr } = await supabase
      .from("questions")
      .select("id, nickname, body, likes, created_at")
      .eq("session_id", session.id)
      .eq("status", "live")
      .order("likes", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(role === "screen" ? 5 : 100);
    if (questionsErr) throw questionsErr;

    const { data: latestSynthesis, error: synthErr } = await supabase
      .from("syntheses")
      .select("clusters, lines, opinion_count, created_at")
      .eq("session_id", session.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (synthErr) throw synthErr;

    const responseBody: Record<string, unknown> = {
      session: {
        id: session.id,
        title: session.title,
        active_view: session.active_view,
        active_poll_id: session.active_poll_id,
      },
      active_poll: activePoll,
      live_questions: liveQuestions ?? [],
      latest_synthesis: latestSynthesis ?? null,
    };

    if (role === "admin") {
      const { data: reviewQueue, error: reviewErr } = await supabase
        .from("questions")
        .select("id, nickname, body, status, created_at")
        .eq("session_id", session.id)
        .eq("status", "review")
        .order("created_at", { ascending: true });
      if (reviewErr) throw reviewErr;

      const { data: allPolls, error: allPollsErr } = await supabase
        .from("polls")
        .select("id, type, question, is_active")
        .eq("session_id", session.id)
        .order("created_at", { ascending: true });
      if (allPollsErr) throw allPollsErr;

      // 접속자 presence 테이블이 없으므로(websocket 금지 원칙) 참여 추정치로만 제공한다.
      const { count: respondedCount } = await supabase
        .from("votes")
        .select("token", { count: "exact", head: true })
        .eq("poll_id", session.active_poll_id ?? "");

      responseBody.ai_screening = session.ai_screening;
      responseBody.ai_synthesis = session.ai_synthesis;
      responseBody.review_queue = reviewQueue ?? [];
      responseBody.polls = allPolls ?? [];
      responseBody.active_poll_votes = activePollVotes;
      responseBody.counters = {
        responded: respondedCount ?? 0,
        review_pending: (reviewQueue ?? []).length,
      };
    }

    return jsonResponse(responseBody);
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "internal error", 500);
  }
});
