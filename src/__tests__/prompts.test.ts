import { describe, it, expect } from "vitest";
import { analyzePrompt, implementPrompt, reviewPrompt } from "../prompts.js";

describe("analyzePrompt", () => {
  it("includes objective, paths and constraints", () => {
    const text = analyzePrompt({
      objective: "find X",
      paths: ["a.ts", "b/"],
      constraints: ["no guessing"],
    });
    expect(text).toContain("Objective: find X");
    expect(text).toContain("- a.ts\n- b/");
    expect(text).toContain("Constraints:\n- no guessing");
    expect(text).toContain("file:line evidence");
  });

  it("omits the constraints section when there are none", () => {
    expect(analyzePrompt({ objective: "x", paths: ["a"] })).not.toContain("Constraints");
    expect(analyzePrompt({ objective: "x", paths: ["a"], constraints: [] })).not.toContain(
      "Constraints",
    );
  });
});

describe("implementPrompt", () => {
  it("includes criteria and validation commands", () => {
    const text = implementPrompt({
      objective: "add Y",
      paths: ["src/y.ts"],
      acceptance_criteria: ["tests pass", "no API change"],
      test_commands: ["npx vitest run"],
    });
    expect(text).toContain("- tests pass\n- no API change");
    expect(text).toContain("Validation commands");
    expect(text).toContain("- npx vitest run");
    expect(text).toContain("instead of claiming success");
  });

  it("omits the validation section when there are no commands", () => {
    const text = implementPrompt({
      objective: "x",
      paths: ["a"],
      acceptance_criteria: ["c"],
      test_commands: [],
    });
    expect(text).not.toContain("Validation commands");
  });
});

describe("reviewPrompt", () => {
  it("wraps a diff in a fence and lists focus", () => {
    const text = reviewPrompt({
      objective: "check",
      diff: "--- a\n+++ b",
      review_focus: ["security"],
    });
    expect(text).toContain("```diff\n--- a\n+++ b\n```");
    expect(text).toContain("Focus:\n- security");
    expect(text).toContain("severity (high/medium/low)");
  });

  it("works with paths only", () => {
    const text = reviewPrompt({ objective: "check", paths: ["src/x.ts"] });
    expect(text).toContain("- src/x.ts");
    expect(text).not.toContain("Diff under review");
  });
});
