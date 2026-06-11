// Optional AI analysis adapter. The MVP ships with the rule-based classifier
// only — this interface exists so an LLM-backed implementation can be dropped
// in later without touching the refresh pipeline. No API key is required.

import type { Sentiment } from "../types";

export interface AIAnalysisResult {
  sentiment: Sentiment;
  themes: string[];
  needsResponse: boolean;
}

export interface AIAnalysisProvider {
  name: string;
  available(): boolean;
  analyzeComment(text: string): Promise<AIAnalysisResult | null>;
  /** Summarize recurring themes across many comments. */
  extractThemes(texts: string[]): Promise<string[]>;
}

/** Default no-op implementation; the rule-based classifier remains in charge. */
export class NoopAIAnalysisProvider implements AIAnalysisProvider {
  name = "none";
  available(): boolean {
    return false;
  }
  async analyzeComment(): Promise<AIAnalysisResult | null> {
    return null;
  }
  async extractThemes(): Promise<string[]> {
    return [];
  }
}

export function getAIAnalysisProvider(): AIAnalysisProvider {
  // Future: return an Anthropic/OpenAI-backed provider when a key is present.
  return new NoopAIAnalysisProvider();
}
