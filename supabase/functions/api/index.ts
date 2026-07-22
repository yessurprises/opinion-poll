import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { checkAdminKey, getServiceClient } from "../_shared/db.ts";
import { containsBannedWord } from "../_shared/moderation.ts";
import { screenQuestion } from "../_shared/openai.ts";
import { runSynthesis } from "../_shared/synthesize_core.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("POST only", 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid json body", 400);
  }

  const action = body.action as string | undefined;
  if (!action) return errorResponse("missing action", 400);

  const supabase = getServiceClient();

  try {
    switch (action) {
      case "join": {
        const code = String(body.code ?? "").trim();
        if (!code) return errorResponse("missing code", 400);
        const { data: session, error } = await supabase
          .from("sessions")
          .select("id, title")
          .eq("code", code)
          .maybeSingle();
        if (error) throw error;
        if (!session) return errorResponse("session not found", 404);
        const token = crypto.randomUUID();
        return jsonResponse({ token, session_id: session.id, title: session.title });
      }

      case "vote": {
        const { token, poll_id, value } = body as { token?: string; poll_id?: string; value?: unknown };
        if (!token || !poll_id || value === undefined) return errorResponse("missing token/poll_id/value", 400);

        const { data: poll, error: pollErr } = await supabase
          .from("polls")
          .select("id, type, is_active")
          .eq("id", poll_id)
          .maybeSingle();
        if (pollErr) throw pollErr;
        if (!poll || !poll.is_active) return errorResponse("poll not active", 409);

        if (poll.type === "open" || poll.type === "wordcloud") {
          const text = typeof value === "object" ? String((value as { text?: string }).text ?? "") : String(value);
          if (containsBannedWord(text)) return errorResponse("금칙어가 포함되어 제출할 수 없습니다", 422);

          // 복수 제출 허용, 1인당 폴별 20건 한도 (도배 방지)
          const { count, error: countErr } = await supabase
            .from("votes")
            .select("id", { count: "exact", head: true })
            .eq("poll_id", poll_id)
            .eq("token", token);
          if (countErr) throw countErr;
          if ((count ?? 0) >= 20) return errorResponse("제출 한도(20건)를 초과했습니다", 429);

          const { error: insertErr } = await supabase.from("votes").insert({ poll_id, token, value });
          if (insertErr) throw insertErr;
          return jsonResponse({ ok: true });
        }

        // choice: 1인 1표 유지하되 재투표 시 기존 표를 변경
        const { data: existing, error: findErr } = await supabase
          .from("votes")
          .select("id")
          .eq("poll_id", poll_id)
          .eq("token", token)
          .maybeSingle();
        if (findErr) throw findErr;

        if (existing) {
          const { error: updateErr } = await supabase.from("votes").update({ value }).eq("id", existing.id);
          if (updateErr) throw updateErr;
          return jsonResponse({ ok: true, changed: true });
        }
        const { error: insertErr } = await supabase.from("votes").insert({ poll_id, token, value });
        if (insertErr) throw insertErr;
        return jsonResponse({ ok: true });
      }

      case "ask": {
        const { token, session_id, nickname, body: questionBody } = body as {
          token?: string;
          session_id?: string;
          nickname?: string;
          body?: string;
        };
        if (!token || !session_id || !questionBody?.trim()) {
          return errorResponse("missing token/session_id/body", 400);
        }
        const text = questionBody.trim().slice(0, 500);

        const { data: session, error: sessionErr } = await supabase
          .from("sessions")
          .select("ai_screening")
          .eq("id", session_id)
          .maybeSingle();
        if (sessionErr) throw sessionErr;
        if (!session) return errorResponse("session not found", 404);

        const status = session.ai_screening ? await screenQuestion(text) : "review";

        const { data: question, error: insertErr } = await supabase
          .from("questions")
          .insert({ session_id, token, nickname: nickname?.slice(0, 30) ?? null, body: text, status })
          .select("id, status")
          .single();
        if (insertErr) throw insertErr;
        return jsonResponse({ id: question.id, status: question.status });
      }

      case "like": {
        const { token, question_id } = body as { token?: string; question_id?: string };
        if (!token || !question_id) return errorResponse("missing token/question_id", 400);

        const { data: question, error: getErr } = await supabase
          .from("questions")
          .select("likes, liked_by")
          .eq("id", question_id)
          .maybeSingle();
        if (getErr) throw getErr;
        if (!question) return errorResponse("question not found", 404);

        const likedBy = new Set<string>((question.liked_by as string[]) ?? []);
        let likes = question.likes;
        if (likedBy.has(token)) {
          likedBy.delete(token);
          likes = Math.max(0, likes - 1);
        } else {
          likedBy.add(token);
          likes += 1;
        }

        const { error: updateErr } = await supabase
          .from("questions")
          .update({ likes, liked_by: Array.from(likedBy) })
          .eq("id", question_id);
        if (updateErr) throw updateErr;
        return jsonResponse({ likes, liked: likedBy.has(token) });
      }

      case "admin_set_view": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { session_id, view } = body as { session_id?: string; view?: string };
        if (!session_id || !view) return errorResponse("missing session_id/view", 400);
        if (!["idle", "poll", "qna", "synthesis"].includes(view)) return errorResponse("invalid view", 400);
        const { error } = await supabase.from("sessions").update({ active_view: view }).eq("id", session_id);
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      case "admin_poll_create": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { session_id, type, question, options } = body as {
          session_id?: string;
          type?: string;
          question?: string;
          options?: unknown;
        };
        if (!session_id) return errorResponse("missing session_id", 400);
        if (!type || !["choice", "wordcloud", "open"].includes(type)) {
          return errorResponse("type은 choice/wordcloud/open 중 하나여야 합니다", 400);
        }
        const q = String(question ?? "").trim().slice(0, 200);
        if (!q) return errorResponse("문항을 입력하세요", 400);

        let opts: string[] = [];
        if (type === "choice") {
          if (!Array.isArray(options)) return errorResponse("choice 폴은 보기 목록이 필요합니다", 400);
          opts = options.map((o) => String(o).trim().slice(0, 50)).filter(Boolean);
          opts = [...new Set(opts)]; // 중복 보기 제거
          if (opts.length < 2) return errorResponse("보기는 2개 이상이어야 합니다", 400);
          if (opts.length > 10) return errorResponse("보기는 10개 이하여야 합니다", 400);
        }

        const { data: session, error: sessionErr } = await supabase
          .from("sessions")
          .select("id")
          .eq("id", session_id)
          .maybeSingle();
        if (sessionErr) throw sessionErr;
        if (!session) return errorResponse("session not found", 404);

        const { data: poll, error } = await supabase
          .from("polls")
          .insert({ session_id, type, question: q, options: opts })
          .select("id")
          .single();
        if (error) throw error;
        return jsonResponse({ id: poll.id });
      }

      case "admin_poll_delete": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { poll_id } = body as { poll_id?: string };
        if (!poll_id) return errorResponse("missing poll_id", 400);
        // votes는 FK on delete cascade로 함께 삭제, 활성 폴이었다면 active_poll_id는 set null
        const { error } = await supabase.from("polls").delete().eq("id", poll_id);
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      case "admin_vote_delete": {
        // 개별 응답(선택형 표·워드클라우드 단어·자유의견) 원터치 삭제 — 부적절한 응답 대응용
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { vote_id } = body as { vote_id?: string };
        if (!vote_id) return errorResponse("missing vote_id", 400);
        const { error } = await supabase.from("votes").delete().eq("id", vote_id);
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      case "admin_poll_toggle": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { poll_id, is_active } = body as { poll_id?: string; is_active?: boolean };
        if (!poll_id || typeof is_active !== "boolean") return errorResponse("missing poll_id/is_active", 400);

        const { data: poll, error: pollErr } = await supabase
          .from("polls")
          .select("id, session_id")
          .eq("id", poll_id)
          .maybeSingle();
        if (pollErr) throw pollErr;
        if (!poll) return errorResponse("poll not found", 404);

        if (is_active) {
          const { error: deactivateErr } = await supabase
            .from("polls")
            .update({ is_active: false })
            .eq("session_id", poll.session_id);
          if (deactivateErr) throw deactivateErr;
        }
        const { error: updateErr } = await supabase.from("polls").update({ is_active }).eq("id", poll_id);
        if (updateErr) throw updateErr;

        const { error: sessionErr } = await supabase
          .from("sessions")
          .update({ active_poll_id: is_active ? poll_id : null })
          .eq("id", poll.session_id);
        if (sessionErr) throw sessionErr;

        return jsonResponse({ ok: true });
      }

      case "admin_question_status": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { question_id, status } = body as { question_id?: string; status?: string };
        if (!question_id || !status) return errorResponse("missing question_id/status", 400);
        if (!["live", "review", "hidden", "answered"].includes(status)) return errorResponse("invalid status", 400);
        const { error } = await supabase.from("questions").update({ status }).eq("id", question_id);
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      case "admin_synthesize": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { session_id } = body as { session_id?: string };
        if (!session_id) return errorResponse("missing session_id", 400);
        const result = await runSynthesis(session_id);
        return jsonResponse(result);
      }

      case "admin_ai_toggle": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { session_id, ai_screening, ai_synthesis } = body as {
          session_id?: string;
          ai_screening?: boolean;
          ai_synthesis?: boolean;
        };
        if (!session_id || (typeof ai_screening !== "boolean" && typeof ai_synthesis !== "boolean")) {
          return errorResponse("missing session_id/ai_screening|ai_synthesis", 400);
        }
        const patch: Record<string, boolean> = {};
        if (typeof ai_screening === "boolean") patch.ai_screening = ai_screening;
        if (typeof ai_synthesis === "boolean") patch.ai_synthesis = ai_synthesis;
        const { error } = await supabase.from("sessions").update(patch).eq("id", session_id);
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      case "admin_manual_synthesis": {
        // LLM 전면 장애 시 운영자가 종합문을 직접 작성해 게시하는 수기 경로
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { session_id, lines } = body as { session_id?: string; lines?: string[] };
        if (!session_id || !Array.isArray(lines)) return errorResponse("missing session_id/lines", 400);
        const cleaned = lines.map((l) => String(l).trim().slice(0, 120)).filter(Boolean).slice(0, 5);
        if (!cleaned.length) return errorResponse("lines is empty", 400);

        // 현재 의견 수를 기록해 두면, AI를 다시 켜도 신규 응답이 없는 한 cron이 수기 종합문을 덮어쓰지 않는다
        let opinionCount = 0;
        const { data: sessionRow } = await supabase
          .from("sessions")
          .select("active_poll_id")
          .eq("id", session_id)
          .maybeSingle();
        if (sessionRow?.active_poll_id) {
          const { count } = await supabase
            .from("votes")
            .select("id", { count: "exact", head: true })
            .eq("poll_id", sessionRow.active_poll_id);
          opinionCount = count ?? 0;
        }

        const { error } = await supabase.from("syntheses").insert({
          session_id,
          clusters: [],
          lines: cleaned,
          opinion_count: opinionCount,
        });
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      case "admin_export": {
        if (!checkAdminKey(req, body)) return errorResponse("unauthorized", 401);
        const { session_id } = body as { session_id?: string };
        if (!session_id) return errorResponse("missing session_id", 400);

        const { data: questions, error } = await supabase
          .from("questions")
          .select("created_at, nickname, body, status, likes")
          .eq("session_id", session_id)
          .order("created_at", { ascending: true });
        if (error) throw error;

        const escape = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const header = "created_at,nickname,body,status,likes";
        const rows = (questions ?? []).map(
          (q) => `${escape(q.created_at)},${escape(q.nickname)},${escape(q.body)},${escape(q.status)},${escape(q.likes)}`,
        );
        const csv = [header, ...rows].join("\n");

        return new Response(csv, {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="questions_${session_id}.csv"`,
          },
        });
      }

      default:
        return errorResponse(`unknown action: ${action}`, 400);
    }
  } catch (err) {
    console.error(err);
    return errorResponse(err instanceof Error ? err.message : "internal error", 500);
  }
});
