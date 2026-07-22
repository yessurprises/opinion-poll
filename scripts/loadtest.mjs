// 400 동시 참가자 시뮬레이션: join -> 폴 투표 -> 결과가 screen 폴링에 반영되는 시간 측정
// 사용법: node scripts/loadtest.mjs <functions_url> <session_code> [client_count]
// 예:    node scripts/loadtest.mjs https://xxxx.supabase.co/functions/v1 DEMO 400

const FUNCTIONS_URL = process.argv[2];
const CODE = process.argv[3];
const CLIENTS = Number(process.argv[4] || 400);

if (!FUNCTIONS_URL || !CODE) {
  console.error("usage: node scripts/loadtest.mjs <functions_url> <session_code> [client_count]");
  process.exit(1);
}

async function callApi(action, payload) {
  const res = await fetch(`${FUNCTIONS_URL}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...payload }),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

async function fetchState(role) {
  const res = await fetch(`${FUNCTIONS_URL}/state?code=${encodeURIComponent(CODE)}&role=${role}`);
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  console.log(`[0/${CLIENTS}] join 시작...`);
  const joinStart = Date.now();
  const tokens = [];
  const joinErrors = [];

  await Promise.all(
    Array.from({ length: CLIENTS }, async (_, i) => {
      const r = await callApi("join", { code: CODE });
      if (r.ok) tokens.push({ token: r.data.token, sessionId: r.data.session_id });
      else joinErrors.push(r.status);
      if ((i + 1) % 50 === 0) console.log(`[${i + 1}/${CLIENTS}] join 진행중`);
    }),
  );
  console.log(`join 완료: 성공 ${tokens.length}, 실패 ${joinErrors.length}, ${Date.now() - joinStart}ms`);

  const state0 = await fetchState("guest");
  if (!state0.ok || !state0.data.active_poll) {
    console.error("활성 폴이 없습니다. admin에서 폴을 켜고 다시 실행하세요.");
    process.exit(1);
  }
  const poll = state0.data.active_poll;
  const option = poll.type === "choice" ? (poll.options[0] || "A") : null;

  console.log(`\n[투표 시작] poll=${poll.id} type=${poll.type}`);
  const voteStart = Date.now();
  let voteOk = 0, voteFail = 0;

  await Promise.all(
    tokens.map(async ({ token }, i) => {
      const value = option ? { option } : { text: `의견-${i}-${Math.random().toString(36).slice(2, 6)}` };
      const r = await callApi("vote", { token, poll_id: poll.id, value });
      if (r.ok) voteOk++; else voteFail++;
    }),
  );
  const voteDuration = Date.now() - voteStart;
  console.log(`투표 완료: 성공 ${voteOk}, 실패 ${voteFail}, ${voteDuration}ms`);

  console.log(`\n[반영 확인] screen 폴링(3초 주기)으로 결과 갱신 시간 측정...`);
  const checkStart = Date.now();
  let reflectedMs = null;
  for (let i = 0; i < 20; i++) {
    const s = await fetchState("screen");
    const total = s.data?.active_poll?.total_votes || 0;
    if (total >= voteOk) {
      reflectedMs = Date.now() - checkStart;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n=== 결과 ===`);
  console.log(`동접 클라이언트: ${CLIENTS}`);
  console.log(`투표 처리 시간: ${voteDuration}ms`);
  console.log(`screen 반영까지: ${reflectedMs === null ? "20회 시도 내 미확인" : reflectedMs + "ms"}`);
  const pass = voteFail === 0 && reflectedMs !== null && reflectedMs <= 6000;
  console.log(`수용기준(6초 내 반영, 무손실): ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
