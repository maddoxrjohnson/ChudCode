/**
 * flaw-review.ts: grade a review of an agent's diff by the flaws it finds.
 *
 * The exercise is a unified diff an agent "wrote", with flaws planted in its added
 * lines (an injection, a leaked secret, an API that does not exist, a weakened test)
 * and decoys: lines that look suspicious and are fine. The learner marks lines, each
 * with a category and a reason. A mark finds a flaw when it lands on the same file
 * within `LINE_SLACK` lines of the flaw's range; the category is scored separately,
 * so a learner who sees that a line is wrong but names it badly still gets the find.
 *
 * The gate: every critical flaw found, at least `RECALL_THRESHOLD` of all flaws found,
 * and no more false alarms than `falseAlarmLimit` allows.
 */

export const FLAW_CATEGORIES = [
  "injection",
  "secret",
  "hallucinated-api",
  "weakened-test",
  "over-permission",
  "missing-authz",
  "silent-error",
  "scope-creep",
  "other",
] as const;
export type FlawCategory = (typeof FLAW_CATEGORIES)[number];

export const LINE_SLACK = 2;
export const RECALL_THRESHOLD = 0.7;
export const MAX_MARKS = 40;

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  /** The line's number in the new file; absent for a deleted line. */
  newLine?: number;
  oldLine?: number;
  text: string;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
}

/**
 * Parse a unified diff (`--- a/x`, `+++ b/x`, `@@ -a,b +c,d @@`). Throws with a line
 * number on anything malformed, so validation can say what to fix.
 */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  for (const [i, raw] of lines.entries()) {
    if (i === lines.length - 1 && raw === "") continue; // the diff's own final newline
    if (raw.startsWith("diff --git") || raw.startsWith("index ")) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("--- ")) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim().replace(/^b\//, "");
      if (!target || target === "/dev/null")
        throw new Error(`line ${i + 1}: a +++ header needs a file`);
      file = { path: target, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      if (!file) throw new Error(`line ${i + 1}: a hunk before any +++ header`);
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) {
      if (raw.trim() && i < lines.length - 1)
        throw new Error(`line ${i + 1}: text outside a hunk: ${raw.slice(0, 60)}`);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const mark = raw[0] ?? " ";
    const text = raw.slice(1);
    if (mark === "+") file.lines.push({ kind: "add", newLine: newNo++, text });
    else if (mark === "-") file.lines.push({ kind: "del", oldLine: oldNo++, text });
    else if (mark === " " || raw === "")
      file.lines.push({ kind: "ctx", newLine: newNo++, oldLine: oldNo++, text });
    else throw new Error(`line ${i + 1}: a hunk line must start with +, -, or a space`);
  }
  if (files.length === 0) throw new Error("the diff has no files");
  return files;
}

export interface PlantedFlaw {
  id: string;
  file: string;
  /** First and last new-file line of the flaw. */
  line: number;
  endLine?: number;
  category: FlawCategory;
  /** A critical flaw must be found for the review to pass. */
  critical: boolean;
  /** Why it is wrong and what the fix is, for the debrief. */
  explanation: string;
}

export interface Decoy {
  file: string;
  line: number;
  /** Why it looks wrong and is not. */
  note: string;
}

export interface FlawSpec {
  diff: string;
  flaws: PlantedFlaw[];
  decoys: Decoy[];
}

export interface ReviewMark {
  file: string;
  line: number;
  category: FlawCategory;
  reason: string;
}

export const FLAWS_MIN = 4;
export const FLAWS_MAX = 12;
export const DECOYS_MIN = 2;

/** Every problem with a flaw spec, or [] when it is sound. */
export function flawSpecErrors(spec: FlawSpec): string[] {
  let files: DiffFile[];
  try {
    files = parseDiff(spec.diff);
  } catch (err) {
    return [`diff does not parse: ${(err as Error).message}`];
  }
  const errors: string[] = [];
  const lineOf = (file: string, line: number) =>
    files.find((f) => f.path === file)?.lines.find((l) => l.newLine === line);
  if (spec.flaws.length < FLAWS_MIN || spec.flaws.length > FLAWS_MAX)
    errors.push(`flaws needs ${FLAWS_MIN} to ${FLAWS_MAX} entries`);
  if (!spec.flaws.some((f) => f.critical)) errors.push("at least one flaw must be critical");
  if (spec.decoys.length < DECOYS_MIN) errors.push(`decoys needs at least ${DECOYS_MIN} entries`);
  const ids = new Set<string>();
  for (const flaw of spec.flaws) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flaw.id))
      errors.push(`flaw id ${flaw.id} must be kebab-case`);
    if (ids.has(flaw.id)) errors.push(`flaw id ${flaw.id} is repeated`);
    ids.add(flaw.id);
    if (!(FLAW_CATEGORIES as readonly string[]).includes(flaw.category))
      errors.push(`flaw ${flaw.id}: category must be one of ${FLAW_CATEGORIES.join(", ")}`);
    const end = flaw.endLine ?? flaw.line;
    if (end < flaw.line) errors.push(`flaw ${flaw.id}: end_line is before line`);
    for (let n = flaw.line; n <= end; n++) {
      const at = lineOf(flaw.file, n);
      if (!at) {
        errors.push(`flaw ${flaw.id}: ${flaw.file}:${n} is not a line of the new file in the diff`);
        break;
      }
    }
    if (lineOf(flaw.file, flaw.line)?.kind !== "add")
      errors.push(
        `flaw ${flaw.id}: ${flaw.file}:${flaw.line} must be an added line; the flaw is the agent's`,
      );
    if (flaw.explanation.trim().length < 20) errors.push(`flaw ${flaw.id}: explain it`);
  }
  for (const decoy of spec.decoys) {
    if (!lineOf(decoy.file, decoy.line))
      errors.push(`decoy ${decoy.file}:${decoy.line} is not a line of the new file in the diff`);
    if (spec.flaws.some((f) => matches(f, decoy.file, decoy.line, 0)))
      errors.push(`decoy ${decoy.file}:${decoy.line} sits on a flaw`);
  }
  return errors;
}

function matches(flaw: PlantedFlaw, file: string, line: number, slack = LINE_SLACK): boolean {
  return (
    file === flaw.file && line >= flaw.line - slack && line <= (flaw.endLine ?? flaw.line) + slack
  );
}

export interface FlawGrade {
  found: Array<{
    id: string;
    category: FlawCategory;
    critical: boolean;
    categoryRight: boolean;
    explanation: string;
  }>;
  missed: Array<{
    id: string;
    category: FlawCategory;
    critical: boolean;
    explanation: string;
    file: string;
    line: number;
  }>;
  /** Marks that found no flaw; `decoy` holds the note when the mark hit a decoy. */
  falseAlarms: Array<{ file: string; line: number; reason: string; decoy?: string }>;
  criticalMissed: number;
  recall: number;
  problems: string[];
  passed: boolean;
}

export function falseAlarmLimit(flaws: number): number {
  return Math.max(2, Math.floor(flaws / 2));
}

export function gradeReview(spec: FlawSpec, marks: readonly ReviewMark[]): FlawGrade {
  const used = new Set<number>();
  const found: FlawGrade["found"] = [];
  const missed: FlawGrade["missed"] = [];
  for (const flaw of spec.flaws) {
    // Prefer a mark that also names the category.
    const candidates = marks
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => !used.has(i) && matches(flaw, m.file, m.line));
    const pick = candidates.find(({ m }) => m.category === flaw.category) ?? candidates[0];
    if (pick) {
      used.add(pick.i);
      found.push({
        id: flaw.id,
        category: flaw.category,
        critical: flaw.critical,
        categoryRight: pick.m.category === flaw.category,
        explanation: flaw.explanation,
      });
    } else {
      missed.push({
        id: flaw.id,
        category: flaw.category,
        critical: flaw.critical,
        explanation: flaw.explanation,
        file: flaw.file,
        line: flaw.line,
      });
    }
  }
  // A second mark on a flaw already found is a duplicate, not a false alarm.
  const falseAlarms = marks
    .filter((m, i) => !used.has(i) && !spec.flaws.some((f) => matches(f, m.file, m.line)))
    .map((m) => {
      const decoy = spec.decoys.find(
        (d) => d.file === m.file && Math.abs(d.line - m.line) <= LINE_SLACK,
      );
      return {
        file: m.file,
        line: m.line,
        reason: m.reason,
        ...(decoy ? { decoy: decoy.note } : {}),
      };
    });
  const recall = spec.flaws.length ? found.length / spec.flaws.length : 0;
  const criticalMissed = missed.filter((m) => m.critical).length;
  const problems: string[] = [];
  if (criticalMissed > 0)
    problems.push(
      `${criticalMissed} critical flaw${criticalMissed === 1 ? " was" : "s were"} missed.`,
    );
  if (recall < RECALL_THRESHOLD)
    problems.push(
      `Found ${found.length} of ${spec.flaws.length} flaws; the bar is ${Math.round(RECALL_THRESHOLD * 100)}%.`,
    );
  const limit = falseAlarmLimit(spec.flaws.length);
  if (falseAlarms.length > limit)
    problems.push(`${falseAlarms.length} marks found nothing; at most ${limit} are allowed.`);
  return {
    found,
    missed,
    falseAlarms,
    criticalMissed,
    recall,
    problems,
    passed: problems.length === 0,
  };
}
