// Rule-based comment keyword tagging for the Wachter campaign.

export interface KeywordRule {
  tag: string;
  pattern: RegExp;
}

export const KEYWORD_RULES: KeywordRule[] = [
  { tag: "wachter", pattern: /\bwachter\b/i },
  { tag: "bootcamp", pattern: /\bboot\s?camps?\b/i },
  { tag: "low voltage", pattern: /\blow[\s-]?volt(age)?\b|\blo[\s-]?vo\b/i },
  { tag: "training", pattern: /\btrain(ing|ed|s)?\b|\blearn(ing)?\b/i },
  { tag: "job/career", pattern: /\b(job|career|position|opening|work(ing)? (there|for))\b/i },
  { tag: "pay", pattern: /\b(pay|salary|wage|per hour|hourly|make (a )?(year|hour)|\$\d)/i },
  { tag: "certifications", pattern: /\bcert(ification|ified|s)?\b|\bbicsi\b|\bosha\b/i },
  { tag: "tools", pattern: /\btools?\b|\btoolbag\b|\btool belt\b/i },
  { tag: "hiring", pattern: /\bhir(e|ing|ed)\b|\bapply(ing)?\b|\bapplication\b|\brecruit/i },
  { tag: "mount laurel", pattern: /\bmount\s?laurel\b|\bmt\.?\s?laurel\b/i },
  { tag: "safety", pattern: /\bsafety\b|\bppe\b|\bhard\s?hat\b|\bharness\b/i },
  { tag: "cabling", pattern: /\bcabl(e|es|ing)\b|\bcat\s?(5e?|6a?)\b|\bfiber\b|\bethernet\b/i },
  { tag: "technician", pattern: /\btech(nician)?s?\b/i },
  { tag: "apprenticeship", pattern: /\bapprentice(ship)?s?\b/i },
  { tag: "union/non-union", pattern: /\b(non[\s-]?)?union\b/i },
  { tag: "travel", pattern: /\btravel(ing|s)?\b|\bon the road\b|\bper diem\b/i },
];

export function tagComment(text: string): string[] {
  const tags: string[] = [];
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(text)) tags.push(rule.tag);
  }
  return tags;
}
