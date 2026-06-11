import { describe, expect, it } from "vitest";
import { KEYWORD_RULES, tagComment } from "@/lib/intel/keywords";
import { classifyComment } from "@/lib/intel/sentiment";

describe("tagComment", () => {
  it("tags campaign keywords", () => {
    const tags = tagComment("The Wachter bootcamp in Mount Laurel looks great");
    expect(tags).toContain("wachter");
    expect(tags).toContain("bootcamp");
    expect(tags).toContain("mount laurel");
  });
  it("tags pay and low voltage questions", () => {
    const tags = tagComment("how much does a low voltage tech make per hour?");
    expect(tags).toEqual(expect.arrayContaining(["low voltage", "pay", "technician"]));
  });
  it("tags certifications, tools, hiring, apprenticeship, union, travel, safety, cabling", () => {
    expect(tagComment("do I need BICSI certs?")).toContain("certifications");
    expect(tagComment("what tools should I buy")).toContain("tools");
    expect(tagComment("are they hiring right now?")).toContain("hiring");
    expect(tagComment("is this an apprenticeship?")).toContain("apprenticeship");
    expect(tagComment("union or non-union?")).toContain("union/non-union");
    expect(tagComment("how much travel is involved")).toContain("travel");
    expect(tagComment("always wear your PPE")).toContain("safety");
    expect(tagComment("running cat6 all day")).toContain("cabling");
    expect(tagComment("paid training program")).toContain("training");
    expect(tagComment("I want a job there")).toContain("job/career");
  });
  it("returns empty for unrelated text", () => {
    expect(tagComment("nice weather today")).toEqual([]);
  });
  it("every rule has a tag and pattern", () => {
    for (const rule of KEYWORD_RULES) {
      expect(rule.tag.length).toBeGreaterThan(0);
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe("classifyComment", () => {
  it("detects questions and flags them for response", () => {
    const r = classifyComment("How do I apply?");
    expect(r.sentiment).toBe("question");
    expect(r.isQuestion).toBe(true);
    expect(r.needsResponse).toBe(true);
  });
  it("detects question-shaped sentences without a question mark", () => {
    expect(classifyComment("how much do they pay").sentiment).toBe("question");
  });
  it("classifies positive", () => {
    expect(classifyComment("This is awesome, great work 🔥").sentiment).toBe("positive");
  });
  it("classifies negative and flags for response", () => {
    const r = classifyComment("this is a scam, stay away");
    expect(r.sentiment).toBe("negative");
    expect(r.needsResponse).toBe(true);
  });
  it("falls back to neutral", () => {
    expect(classifyComment("posted this from the job site").sentiment).toBe("neutral");
  });
  it("flags hiring intent for response even when not a question", () => {
    const tags = tagComment("I want to apply for the Wachter job, I am ready to start");
    const r = classifyComment("I want to apply for the Wachter job, I am ready to start", tags);
    expect(r.needsResponse).toBe(true);
  });
});
