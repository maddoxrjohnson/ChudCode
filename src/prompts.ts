/**
 * prompts.ts: every piece of text this tool sends to the model.
 *
 * Kept pure and separate so the wording is reviewable and testable. The event prompts
 * are self-contained: each one arrives out of band, possibly many turns after the
 * session started, so it restates which session it is about, what happened, and
 * exactly which tool handles it. Nothing here goes into the system prompt; a session
 * that never interviews pays nothing.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { clipText, formatClock, formatInput, formatValue, plural } from "./format.ts";
import { remaining, type SessionState } from "./flow.ts";
import { loadProgress, type Progress } from "./progress.ts";
import { dueText, relativeDay, type ReviewItem } from "./review.ts";
import type { RunResult, TestCase } from "./runner/types.ts";
import { describeLists, lookupSeed, matchSeedTitle, type SeedEntry } from "./seed.ts";
import { docsDir } from "./store/paths.ts";
import { listProblems, patterns, type ProblemBundle, type ProblemMeta } from "./store/problems.ts";
import { listSessions, type Session } from "./store/sessions.ts";
import type { ValidationReport } from "./validate.ts";

function readDoc(name: string): string {
  return fs.readFileSync(path.join(docsDir(), name), "utf8");
}

const PHASE_WORDS: Record<Session["phase"], string> = {
  briefing: "before Start",
  coding: "coding",
  review: "follow-ups",
  done: "finished",
};

/** One line that places a session: `Session x · Title (easy; pattern) · coding · 23:10 left · …`. */
export function sessionLine(session: Session, now = Date.now()): string {
  const left = remaining(session, now);
  const parts = [
    `Session \`${session.id}\``,
    `${session.problemTitle} (${session.difficulty}; ${session.patterns.join(", ")})`,
    PHASE_WORDS[session.phase],
    left === null
      ? "clock not started"
      : session.endedAt
        ? `clock stopped at ${formatClock(left)}`
        : `${formatClock(left)} left`,
    plural(session.hintsUsed.length, "hint") + " used",
    plural(session.submissions, "submission") +
      (session.lastResult
        ? ` (last ${session.lastResult.passed}/${session.lastResult.total})`
        : ""),
  ];
  return parts.join(" · ");
}

const DELIVERY_NOTE = "This arrived as the result of your `wait_for_candidate` call.";

// ── The brief ─────────────────────────────────────────────────────────────────

export interface BriefRequest {
  mode: "interview" | "review" | "mimic";
  pattern?: string;
  difficulty?: string;
  company?: string;
  title?: string;
}

/** What `begin_interview` returns: the request, the candidate's history, the method. */
export function interviewBrief(request: BriefRequest, hostBrief: string, now = Date.now()): string {
  const parts: string[] = [];

  const asks: string[] = [];
  if (request.pattern) asks.push(`pattern **${request.pattern}**`);
  if (request.difficulty) asks.push(`difficulty **${request.difficulty}**`);
  if (request.company) asks.push(`the kind of problem **${request.company}** asks`);
  if (request.title) asks.push(`something like **${request.title}**`);
  const asked = asks.length
    ? ` They asked for ${asks.join(", ")}.`
    : " They named no pattern or difficulty.";
  const progress = loadProgress(now);
  if (request.mode === "review") {
    parts.push(
      `The user wants a review session: a fresh problem on a pattern that is due.${asked}`,
    );
    parts.push(reviewDirectiveText(progress, request.pattern));
  } else {
    parts.push(`The user wants a mock coding interview.${asked}`);
    if (progress.due.length > 0) {
      parts.push(
        `${plural(progress.due.length, "pattern is", "patterns are")} due for spaced review (listed below). Mention that in one sentence and offer a review session, then do what the user asked.`,
      );
    }
  }
  if (request.title) {
    parts.push(seedTitleText(request.title));
    parts.push(
      "Treat the named problem as a shape, not a script. Author an original problem with `write_problem` that drills the same pattern under the same kind of constraints, with its own story and examples, and set `source.kind` to `mimic` with `mimic_of` naming the title. Never reproduce the named problem's statement. A validated problem on disk that already matches and has not been served is also fine.",
    );
  }
  if (request.pattern) parts.push(seedPatternText(request.pattern));

  parts.push(recentSessionsText(now));
  parts.push(dueListText(progress, 5));
  parts.push(problemsText());
  parts.push(authoringText());
  parts.push(readDoc("INTERVIEWING.md"));
  parts.push(readDoc("RUBRIC.md"));
  parts.push(hostBrief);
  return parts.filter(Boolean).join("\n\n");
}

export function recentSessionsText(now = Date.now(), limit = 5): string {
  const sessions = listSessions(limit);
  if (sessions.length === 0)
    return "## Recent sessions\n\nNone yet. This is the candidate's first session.";
  const lines = sessions.map((s) => {
    const when = relativeDays(s.createdAt, now);
    const outcome = s.verdict
      ? s.verdict.correct
        ? "solved"
        : `not solved (${[!s.verdict.allPassed && "tests failed", !s.verdict.withinTime && "out of time", !s.verdict.complexityOk && "too slow"].filter(Boolean).join(", ")})`
      : s.abandonedReason
        ? `abandoned: ${s.abandonedReason}`
        : s.phase === "done"
          ? "finished"
          : `in progress (${PHASE_WORDS[s.phase]})`;
    return `- ${when}: ${s.problemTitle} (${s.difficulty}; ${s.patterns.join(", ")}) — ${outcome}, ${plural(s.hintsUsed.length, "hint")}`;
  });
  return `## Recent sessions\n\n${lines.join("\n")}`;
}

export function problemsText(limit = 12): string {
  const all = listProblems();
  if (all.length === 0)
    return "## Problems on disk\n\nNone. Nothing can be served until a problem exists.";
  const lines = all.slice(0, limit).map(problemLine);
  const more =
    all.length > limit
      ? `\n…and ${all.length - limit} more. Call \`list_problems\` to filter.`
      : "";
  return `## Problems on disk\n\n${lines.join("\n")}${more}`;
}

export function problemLine(meta: ProblemMeta): string {
  const state =
    meta.validatedAt !== undefined
      ? "validated"
      : meta.source.kind === "hand"
        ? "hand-written"
        : "unvalidated";
  return `- \`${meta.slug}\`: ${meta.title} (${meta.difficulty}; ${meta.patterns.join(", ")}) — ${state}, served ${plural(meta.timesServed, "time")}`;
}

export function patternListText(): string {
  return patterns()
    .map((p) => `- \`${p.id}\`: ${p.name}. ${p.blurb}`)
    .join("\n");
}

/** `- Two Sum (easy; arrays-hashing) — Grind 75 (week 1) and NeetCode 150` */
export function seedLine(entry: SeedEntry): string {
  return `- ${entry.title} (${entry.difficulty}; ${entry.patterns.join(", ")}) — ${describeLists(entry)}`;
}

/** What the seed lists say about a title the user named. */
export function seedTitleText(title: string): string {
  const match = matchSeedTitle(title);
  if (!match) {
    return `No seed list has a problem named **${title}**. Go by what you know of it: its pattern, its constraints, and the twist that makes the pattern necessary. \`lookup_seed\` with a few words of the title may find it under another name.`;
  }
  return `**${match.title}** is on ${describeLists(match)}: ${match.difficulty}, ${match.patterns.join(", ")}.`;
}

/** The shapes a pattern takes in real interviews, from the seed lists. */
export function seedPatternText(pattern: string, limit = 10): string {
  const entries = lookupSeed({ pattern });
  if (entries.length === 0) return "";
  const shown = entries.slice(0, limit).map((e) => `${e.title} (${e.difficulty})`);
  const more =
    entries.length > limit ? `, and ${entries.length - limit} more via \`lookup_seed\`` : "";
  return `## Seed problems for ${pattern}\n\nThe shapes interviewers ask on this pattern, from Grind 75 and NeetCode 150: ${shown.join(", ")}${more}. Use them to choose a realistic shape and difficulty for an original problem; do not reproduce any of them.`;
}

/** `- sliding-window: box 0, 2 days overdue; missed 3 days ago (easy), 1 attempt` */
export function dueLine(item: ReviewItem, now: number): string {
  const last = `${item.lastCorrect ? "solved" : "missed"} ${relativeDays(item.lastAt, now)}${item.lastDifficulty ? ` (${item.lastDifficulty})` : ""}`;
  return `- ${item.id}: box ${item.box}, ${dueText(item.dueAt, now)}; ${last}, ${plural(item.attempts, "attempt")}`;
}

/** What `list_due` returns and what the brief includes: due now, due soon, the streak. */
export function dueListText(progress: Progress, limit: number): string {
  const { now } = progress;
  const lines = ["## Due for review", ""];
  if (progress.due.length === 0) {
    lines.push(
      progress.summary.total === 0
        ? "Nothing is due: no session has been recorded yet."
        : progress.summary.nextDueAt === null
          ? "Nothing is due."
          : `Nothing is due. The next pattern comes due ${relativeDay(progress.summary.nextDueAt, now)}.`,
    );
  } else {
    lines.push(...progress.due.slice(0, limit).map((item) => dueLine(item, now)));
    if (progress.due.length > limit)
      lines.push(
        `…and ${progress.due.length - limit} more. Call \`list_due\` with a higher limit.`,
      );
  }
  if (progress.dueSoon.length > 0) {
    lines.push(
      "",
      `Due soon: ${progress.dueSoon.map((item) => `${item.id} ${relativeDay(item.dueAt, now)}`).join(", ")}.`,
    );
  }
  const mastered = `${progress.summary.mastered} of ${progress.patterns.length} patterns mastered`;
  lines.push(
    "",
    `Streak: ${plural(progress.streakDays, "day")}. ${mastered}; ${plural(progress.summary.total, "pattern")} exercised so far.`,
  );
  return lines.join("\n");
}

/** How to run a review session, given what is due. */
function reviewDirectiveText(progress: Progress, requestedPattern?: string): string {
  const target = requestedPattern
    ? progress.due.find((item) => item.id === requestedPattern)
    : progress.due[0];
  if (!target) {
    const fallback =
      progress.dueSoon[0] ??
      [...progress.due, ...progress.dueSoon].sort((a, b) => a.dueAt - b.dueAt)[0];
    return [
      requestedPattern && progress.due.length > 0
        ? `**${requestedPattern}** is not due. ${progress.due[0]?.id} is the most overdue pattern; serve that unless the user insists.`
        : "Nothing is due for review right now. Tell the user so in one sentence.",
      fallback
        ? `Offer a regular interview on **${fallback.id}**, which comes due ${relativeDay(fallback.dueAt, progress.now)}, or on whatever they prefer.`
        : "Offer a regular interview on a pattern of their choice.",
    ].join(" ");
  }
  return [
    `Serve **${target.id}**: it is ${dueText(target.dueAt, progress.now)} in box ${target.box}, last ${target.lastCorrect ? "solved" : "missed"} ${relativeDays(target.lastAt, progress.now)}.`,
    "A review needs a problem the candidate has not seen: the point is the pattern, not the problem. Use a validated problem on disk tagged with the pattern that has been served 0 times if one exists; otherwise write an original one with `write_problem`, `source.kind` set to `review`, then `validate_problem` until it passes.",
    `Match the difficulty to history: the same as last time after a miss, one step harder after a solve. Call \`start_session\` with \`mode: "review"\`.`,
  ].join(" ");
}

function authoringText(): string {
  return [
    "## Authoring",
    "If no validated problem on disk fits the request and the candidate's history, write one: `lookup_seed` for the shape, `write_problem`, then `validate_problem` until it passes. The method below says what makes a good one. The field-by-field bundle format is in `" +
      path.join(docsDir(), "PROBLEM-FORMAT.md") +
      "` if the `write_problem` schema is not enough.",
  ].join("\n\n");
}

// ── Event prompts ─────────────────────────────────────────────────────────────

function footer(session: Session, now: number): string {
  return `${sessionLine(session, now)}\n${DELIVERY_NOTE}`;
}

export function startedPrompt(session: Session, now = Date.now()): string {
  const note = session.approachNote
    ? `Their approach note: "${session.approachNote}"`
    : "They skipped the approach note.";
  return [
    `The candidate pressed Start. The clock is running: ${formatClock(session.timerMs)}.`,
    note,
    session.approachNote
      ? "Respond to the note with `say_to_candidate` in one or two sentences: confirm it if it is sound, or ask the one question that would sharpen it. If they have not said what it costs, ask for the complexity. Then call `wait_for_candidate`."
      : "Ask them, with `say_to_candidate`, to say in a sentence how they plan to approach it before they code. Then call `wait_for_candidate`.",
    footer(session, now),
  ].join("\n\n");
}

export function notePrompt(session: Session, text: string, now = Date.now()): string {
  return [
    `The candidate posted an approach note:\n\n> ${text.replace(/\n/g, "\n> ")}`,
    "Reply with `say_to_candidate` in one or two sentences. Confirm a sound plan, probe a vague one, or ask what a brute-force plan costs. Then call `wait_for_candidate`.",
    footer(session, now),
  ].join("\n\n");
}

export function messagePrompt(session: Session, text: string, now = Date.now()): string {
  return [
    `The candidate said:\n\n> ${text.replace(/\n/g, "\n> ")}`,
    "Reply with `say_to_candidate`. Answer clarifying questions the way the statement would, no more. Then call `wait_for_candidate`.",
    footer(session, now),
  ].join("\n\n");
}

export function hintUsedPrompt(
  session: Session,
  level: number,
  hintText: string,
  now = Date.now(),
): string {
  return [
    `The candidate took hint ${level} from the page: "${hintText}"`,
    "No reply is required. If they have taken several hints in a row, you may ask with `say_to_candidate` what they will try now. Then call `wait_for_candidate`.",
    footer(session, now),
  ].join("\n\n");
}

export function submissionPrompt(
  session: Session,
  number: number,
  result: RunResult,
  bundle: ProblemBundle,
  now = Date.now(),
): string {
  const allPassed = result.status === "ok" && result.passed === result.total;
  const next = allPassed
    ? "Every case passed. Move to follow-ups with `say_to_candidate`: ask for the time and space complexity, then one question about scale or a breaking input. Wait for each answer with `wait_for_candidate`. When you have what you need, call `record_session`."
    : "Not every case passed. Ask with `say_to_candidate` what they think is failing before you say anything about the cases. If they are stuck, describe the shape of one failing input without quoting it. Then call `wait_for_candidate`.";
  return [
    `The candidate submitted (submission ${number}).`,
    resultText(
      result,
      bundle.tests,
      bundle.meta.signature.params.map((p) => p.name),
    ),
    `Target complexity: ${bundle.meta.complexityTarget.time} time, ${bundle.meta.complexityTarget.space} space.`,
    next,
    footer(session, now),
  ].join("\n\n");
}

export function timerExpiredPrompt(session: Session, now = Date.now()): string {
  return [
    "The timer ran out. The session is now in follow-ups; the candidate can still talk and run code but the clock has stopped.",
    "With `say_to_candidate`, tell them time is up and ask where they got to and what they would do with ten more minutes. Ask for the complexity of what they have. Wait for answers with `wait_for_candidate`, then call `record_session`.",
    footer(session, now),
  ].join("\n\n");
}

export function candidateDonePrompt(session: Session, now = Date.now()): string {
  return [
    "The candidate says they are done. The clock has stopped and the session is in follow-ups.",
    session.submissions === 0
      ? "They never submitted. Ask with `say_to_candidate` whether they want to submit what they have, and what they expect it to do on the examples."
      : "Ask two or three follow-ups with `say_to_candidate`: complexity, a breaking input, what changes at scale. Wait for each answer with `wait_for_candidate`.",
    "When you have what you need, call `record_session`. If you need their code to score it, call `get_session` with `include_code: true`.",
    footer(session, now),
  ].join("\n\n");
}

export function recoveredSessionPrompt(session: Session, now = Date.now()): string {
  return [
    "A session was already in progress when this interviewer connected.",
    "Call `get_session` to see where it stands, greet the candidate briefly with `say_to_candidate` if they are mid-session, then call `wait_for_candidate`.",
    footer(session, now),
  ].join("\n\n");
}

export function nothingYetText(
  seconds: number,
  active: Session[],
  digest: string,
  now = Date.now(),
): string {
  const lines = [`Nothing from the candidate in ${seconds} seconds.`];
  if (active.length === 0) {
    lines.push(
      "No session is in progress. Call `start_session` to begin one, or end your turn if the user is done.",
    );
  } else {
    for (const session of active) lines.push(sessionLine(session, now));
    const coding = active.some((s) => s.phase === "coding");
    lines.push(
      coding
        ? "The candidate is working. Call `wait_for_candidate` again. If several silent minutes have passed with no runs, one short check-in with `say_to_candidate` is fine."
        : "The session is in follow-ups. If you asked a question, call `wait_for_candidate` again; otherwise ask one with `say_to_candidate` or call `record_session`.",
    );
  }
  if (digest) lines.push(digest);
  return lines.join("\n\n");
}

// ── Results and state ─────────────────────────────────────────────────────────

/** The interviewer's view of a run: everything, including hidden cases. */
export function resultText(
  result: RunResult,
  cases: readonly TestCase[],
  paramOrder: string[] = [],
  maxFailures = 6,
): string {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const memory = result.maxRssKb ? ` · ${Math.round(result.maxRssKb / 1024)} MB` : "";
  const lines = [
    `${result.passed}/${result.total} passed · ${describeStatus(result.status)} · ${result.wallMs} ms${memory}`,
  ];

  if (result.status !== "ok" && result.stderrTail) {
    lines.push("", "```", clipText(result.stderrTail.trim(), 1500), "```");
  }

  const failures = result.cases.filter((c) => c.status !== "pass");
  for (const c of failures.slice(0, maxFailures)) {
    const testCase = byId.get(c.id);
    const label = testCase?.label ?? c.id;
    const visibility = testCase?.visible ? "visible" : "hidden";
    lines.push("", `- ${label} (${visibility}): ${c.status}${c.message ? ` — ${c.message}` : ""}`);
    if (testCase?.input !== undefined)
      lines.push(`  input: ${clipText(formatInput(testCase.input, paramOrder), 300)}`);
    else if (testCase?.gen !== undefined) lines.push(`  input: generated by \`${testCase.gen}\``);
    if (c.expected !== undefined)
      lines.push(`  expected: ${clipText(formatValue(c.expected), 200)}`);
    if (c.actual !== undefined) lines.push(`  got: ${clipText(formatValue(c.actual), 200)}`);
    const lastStderr = c.stderr.trim().split("\n").pop();
    if (lastStderr) lines.push(`  stderr: ${clipText(lastStderr, 200)}`);
  }
  if (failures.length > maxFailures)
    lines.push(`- …and ${failures.length - maxFailures} more failing cases`);

  const passed = result.cases
    .filter((c) => c.status === "pass")
    .map((c) => byId.get(c.id)?.label ?? c.id);
  if (passed.length > 0) lines.push("", `Passed: ${passed.join(", ")}`);
  return lines.join("\n");
}

/** What `write_problem` returns. */
export function writtenProblemText(bundle: ProblemBundle, lint: string[]): string {
  const { meta } = bundle;
  const visible = bundle.tests.filter((c) => c.visible).length;
  const lines = [
    `Wrote \`${meta.slug}\`: ${meta.title} (${meta.difficulty}; ${meta.patterns.join(", ")}) with ${visible} visible and ${bundle.tests.length - visible} hidden cases, ${plural(bundle.hints.length, "hint")}. Not yet validated.`,
  ];
  if (lint.length > 0) {
    lines.push(
      "",
      `Lint found ${plural(lint.length, "problem")} that will fail validation:`,
      ...lint.map((l) => `- ${l}`),
      "",
      `Fix them with \`write_problem\` (same slug), then call \`validate_problem\`.`,
    );
  } else {
    lines.push(`Call \`validate_problem\` with slug "${meta.slug}".`);
  }
  return lines.join("\n");
}

/** What `validate_problem` returns. */
export function validationReportText(report: ValidationReport, bundle: ProblemBundle): string {
  const lines = [`## Validation of \`${report.slug}\``, ""];
  lines.push(
    report.lint.length === 0
      ? "Shape: ok."
      : `Shape: ${plural(report.lint.length, "problem")}:\n${report.lint.map((l) => `- ${l}`).join("\n")}`,
  );
  lines.push(
    "",
    "Reference run:",
    resultText(
      report.run,
      bundle.tests,
      bundle.meta.signature.params.map((p) => p.name),
    ),
  );
  if (report.disagreements.length > 0) {
    lines.push(
      "",
      `The reference disagrees with the authored expected output on ${plural(report.disagreements.length, "case")}. One of them is wrong; trace the case by hand to see which.`,
    );
  }
  if (report.broken.length > 0) {
    lines.push(
      "",
      `${plural(report.broken.length, "case")} did not run cleanly (${report.broken.map((c) => `${c.id}: ${c.status}`).join(", ")}). A timeout on the max-size case means the reference is slower than its complexity target; an error means the reference or a generator is broken.`,
    );
  }
  if (report.filled.length > 0) {
    lines.push(
      "",
      `Oracle cases filled from the reference: ${report.filled.join(", ")}${report.passed ? " (written to tests.json)" : " (not written until validation passes)"}.`,
    );
  }
  lines.push(
    "",
    report.passed
      ? `Validated. \`${report.slug}\` can be served: call \`start_session\`.`
      : `Not validated. Fix the bundle with \`write_problem\` (same slug) and call \`validate_problem\` again.`,
  );
  return lines.join("\n");
}

function describeStatus(status: RunResult["status"]): string {
  switch (status) {
    case "ok":
      return "ran to completion";
    case "import-error":
      return "the code did not import";
    case "timeout":
      return "killed at the wall-clock limit";
    case "memory":
      return "out of memory";
    case "killed":
      return "the process was killed";
    default:
      return "the runner failed";
  }
}

/** What `get_session` returns. */
export function sessionSummaryText(
  state: SessionState,
  includeCode: boolean,
  now = Date.now(),
): string {
  const { session } = state;
  const lines = [sessionLine(session, now)];
  lines.push(`Approach note: ${session.approachNote ? `"${session.approachNote}"` : "none"}`);
  if (state.hints.length > 0) {
    lines.push(
      `Hints revealed: ${state.hints.map((h) => `${h.level} ("${clipText(h.text, 80)}")`).join("; ")}`,
    );
  }
  if (state.messages.length > 0) {
    lines.push("", "Conversation on the page:");
    for (const m of state.messages.slice(-12)) {
      lines.push(
        `- ${m.from === "interviewer" ? "You" : "Candidate"}: ${clipText(stripTags(m.html), 400)}`,
      );
    }
  }
  if (session.rubric && session.verdict) {
    lines.push("", `Recorded: ${session.verdict.correct ? "solved" : "not solved"}.`);
  }
  if (includeCode) {
    lines.push("", "Current draft:", "```python", state.draft.trimEnd(), "```");
  } else {
    lines.push("", "Call again with `include_code: true` to see the draft.");
  }
  return lines.join("\n");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function relativeDays(at: number, now: number): string {
  const days = Math.round((now - at) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
