// Prompt builders for the semantic tools. Pure: structured inputs in, worker prompt out.

export interface AnalyzeInput {
  objective: string;
  paths: string[];
  constraints?: string[];
}

export interface ImplementInput extends AnalyzeInput {
  acceptance_criteria: string[];
  test_commands: string[];
}

export interface ReviewInput {
  objective: string;
  paths?: string[];
  diff?: string;
  review_focus?: string[];
}

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
const section = (title: string, items?: string[]) =>
  items?.length ? `\n${title}:\n${list(items)}\n` : "";

export function analyzePrompt(i: AnalyzeInput): string {
  return [
    `Objective: ${i.objective}`,
    section("Scope (read only these paths; use grep/find within them)", i.paths),
    section("Constraints", i.constraints),
    "Report: findings with file:line evidence, then concise conclusions, then open questions.",
  ].join("\n");
}

export function implementPrompt(i: ImplementInput): string {
  return [
    `Objective: ${i.objective}`,
    section("Scope (files you may read and change)", i.paths),
    section("Acceptance criteria (all must hold before you finish)", i.acceptance_criteria),
    section(
      "Validation commands (run each with bash; paste the pass/fail result)",
      i.test_commands,
    ),
    section("Constraints", i.constraints),
    "Make the smallest change that satisfies every criterion. If a validation command fails, fix the cause and re-run it. If you cannot satisfy a criterion, say so explicitly instead of claiming success.",
  ].join("\n");
}

export function reviewPrompt(i: ReviewInput): string {
  return [
    `Review objective: ${i.objective}`,
    section("Paths to inspect", i.paths),
    section("Focus", i.review_focus),
    i.diff ? `\nDiff under review:\n\`\`\`diff\n${i.diff}\n\`\`\`\n` : "",
    "Read the surrounding code before judging the diff. Report each issue as: severity (high/medium/low), file:line, what is wrong, suggested fix. Then list test gaps, then overall confidence (high/medium/low) with one sentence of reasoning. Report 'no issues found' if that is the honest result.",
  ].join("\n");
}
