const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

function apiKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY not set");
  return key;
}

async function chatJson(
  messages: { role: string; content: string }[],
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("openai: empty content");
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

export type ScreenVerdict = "live" | "hidden" | "review";

// ask 동기 심사: 타임아웃 3초, 애매·오류·타임아웃 -> review
export async function screenQuestion(body: string): Promise<ScreenVerdict> {
  try {
    const result = await chatJson(
      [
        {
          role: "system",
          content:
            "너는 행사 실시간 Q&A 질문 심사자다. 아래 기준으로만 판정한다: " +
            "욕설·혐오·인신공격·광고·개인정보 노출이 있으면 reject, 없으면 approve. " +
            "비판적이거나 불편한 질문이어도 위 기준에 해당하지 않으면 approve가 기본이다. " +
            '판단이 애매하면 unclear로 답한다. JSON으로만 답하라: {"verdict":"approve"|"reject"|"unclear"}',
        },
        { role: "user", content: body },
      ],
      3000,
    );
    const verdict = result.verdict;
    if (verdict === "approve") return "live";
    if (verdict === "reject") return "hidden";
    return "review";
  } catch {
    return "review";
  }
}

export interface SynthesisCluster {
  name: string;
  count: number;
  share_pct: number;
  sentiment: string;
  representative_quote: string;
}

export interface SynthesisResult {
  clusters: SynthesisCluster[];
  lines: string[];
}

// 종합: 활성 open 폴의 votes 전체 + 직전 종합 -> 클러스터/3줄 요약
export async function synthesizeOpinions(
  opinions: string[],
  previous: SynthesisResult | null,
): Promise<SynthesisResult> {
  const prompt =
    "다음은 행사 참가자들의 자유 의견 목록이다. 이를 종합해 JSON으로 답하라.\n" +
    '형식: {"clusters":[{"name":str,"count":int,"share_pct":number,"sentiment":"긍정"|"중립"|"부정","representative_quote":str}],"lines":[str,str,str]}\n' +
    "제약: clusters는 2~5개, share_pct 합은 100, representative_quote는 입력 원문 그대로 인용. " +
    "lines는 정확히 3줄, 각 줄 60자 이내 한국어 요약.\n" +
    (previous ? `직전 종합 참고(변화 흐름 반영): ${JSON.stringify(previous)}\n` : "") +
    `의견 목록(${opinions.length}건):\n` +
    opinions.map((o, i) => `${i + 1}. ${o}`).join("\n");

  const result = await chatJson(
    [
      { role: "system", content: "너는 행사 실시간 의견을 종합하는 분석가다. 반드시 JSON만 출력한다." },
      { role: "user", content: prompt },
    ],
    12000,
  );
  return {
    clusters: (result.clusters as SynthesisCluster[]) ?? [],
    lines: (result.lines as string[]) ?? [],
  };
}
