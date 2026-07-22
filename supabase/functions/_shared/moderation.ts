import banned from "./banned.json" with { type: "json" };

const bannedList = banned as string[];

// wordcloud/open 폴 제출용 단순 금칙어 필터 (votes 개별 건은 AI 호출 금지 규칙 때문에 워드매칭만 사용)
export function containsBannedWord(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  return bannedList.some((word) => normalized.includes(word.toLowerCase().replace(/\s+/g, "")));
}
