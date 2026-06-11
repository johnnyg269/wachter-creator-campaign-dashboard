// Lightweight rule-based sentiment + question detection. Intentionally
// conservative: when signals conflict or are weak we say "neutral" rather
// than guessing.

import type { Sentiment } from "../types";

const POSITIVE =
  /\b(awesome|amazing|great|love|cool|nice|fire|dope|sick|impressive|congrats|proud|excellent|solid|good (stuff|work|job)|well done|inspiring|goals|🔥|💪|👏|🙌|❤️|😍)\b|🔥|💪|👏|🙌|❤️|😍/i;

const NEGATIVE =
  /\b(scam|fake|terrible|awful|hate|worst|trash|garbage|underpaid|overworked|exploit|avoid|stay away|don'?t (do|work|join)|warning|sketchy|shady|sucks?|bad (pay|company|idea)|lies?|lying|👎|🤮)\b|👎|🤮/i;

const QUESTION_START =
  /^(how|what|when|where|why|who|which|can|could|do|does|did|is|are|was|were|will|would|should|any(one|body)?)\b/i;

export interface SentimentResult {
  sentiment: Sentiment;
  isQuestion: boolean;
  needsResponse: boolean;
}

export function classifyComment(text: string, tags: string[] = []): SentimentResult {
  const t = text.trim();
  const isQuestion = t.includes("?") || QUESTION_START.test(t);
  const positive = POSITIVE.test(t);
  const negative = NEGATIVE.test(t);

  let sentiment: Sentiment;
  if (isQuestion) sentiment = "question";
  else if (positive && !negative) sentiment = "positive";
  else if (negative && !positive) sentiment = "negative";
  else sentiment = "neutral";

  // A comment deserves a human response when it's a question, when it's
  // negative (reputation), or when it asks about jobs/hiring around Wachter.
  const hiringIntent = tags.some((tag) =>
    ["hiring", "job/career", "bootcamp", "apprenticeship", "pay", "wachter"].includes(tag),
  );
  const needsResponse = isQuestion || sentiment === "negative" || (hiringIntent && t.length > 15);

  return { sentiment, isQuestion, needsResponse };
}
