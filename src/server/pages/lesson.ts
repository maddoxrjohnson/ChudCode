/**
 * lesson.ts: the agentic-coding lesson page. The teaching on the left with its
 * sources, the brief and the answer box in the middle, the interviewer on the right.
 *
 * As with the interview page, everything known at request time is rendered here so
 * the page reads without JavaScript. There is no code editor: the learner works the
 * exercise with their own agent and writes their answer in Markdown.
 */

import type { ChecklistItem } from "../../curriculum.ts";

import { LESSON_DIMENSION_NAMES } from "../../lesson-prompts.ts";
import { formatClock } from "../../format.ts";
import { escapeHtml, renderMarkdown } from "../../markdown.ts";
import type { FactFreshness } from "../../store/fact-checks.ts";
import type {
  CacheGrade,
  DrillGrade,
  LessonSession,
  RefactorGrade,
  ReviewGrade,
} from "../../store/lessons.ts";
import { COST_SLACK, dollars, loadCacheModel } from "../../drill/cache-sim.ts";
import { FLAW_CATEGORIES, LINE_SLACK, parseDiff, type DiffFile } from "../../drill/flaw-review.ts";
import { MAX_REVIEWS, type DrillReveal, type LessonState } from "../../lesson-flow.ts";
import { plural } from "../../format.ts";
import { FACT_REF } from "../../validate-exercise.ts";
import { page, topbar } from "./layout.ts";
import type { CheckResult } from "../../media-lab.ts";

export interface LessonPageOptions {
  moduleName: string;
  /** The lesson's facts with when each was last confirmed, for the sources list. */
  facts: FactFreshness[];
  answers: string[];
  /** For a lab: what the review checks, and the files it may read. */
  checklist?: ChecklistItem[];
  labFiles?: string[];
  /** For a scored drill: the planted bugs its tests missed. */
  survivors?: Array<{ id: string; description: string }>;
  /** For a scored flaw review or cache plan: what was hidden until the debrief. */
  reveal?: DrillReveal | null;
  /** The Next lesson row under a debrief. */
  nextHtml?: string;
  /** For a media lab: the latest measurement's checks. */
  mediaChecks?: CheckResult[] | null;
}

const PHASE_LABELS: Record<LessonSession["phase"], string> = {
  briefing: "Reading",
  coding: "Working",
  review: "Follow-ups",
  done: "Finished",
};

export function lessonPage(state: LessonState, options: LessonPageOptions): string {
  const { session, exercise } = state;
  const messages = state.messages
    .map(
      (m) =>
        `<li class="message from-${m.from}"><div class="message-from">${m.from === "interviewer" ? "Interviewer" : "You"}</div><div class="message-body">${m.html}</div></li>`,
    )
    .join("\n");
  const working = session.phase === "coding" || session.phase === "review";

  const body = `${topbar({
    title: `${escapeHtml(session.lessonTitle)} <span class="badge">${escapeHtml(options.moduleName)}</span>`,
    middle: `<span class="timer" id="timer" data-remaining="${state.remainingMs ?? ""}">${formatClock(state.remainingMs ?? session.timerMs)}</span>`,
    right: `<span class="phase-badge phase-${session.phase}" id="phase">${PHASE_LABELS[session.phase]}</span>
    <span class="presence ${state.listening ? "listening" : ""}" id="presence" title="Whether the interviewer is listening">${state.listening ? "Interviewer listening" : "Interviewer away"}</span>`,
  })}
<main class="panes lesson-panes">
  <section class="pane pane-statement lesson-teaching" id="teaching">
    ${teachingHtml(exercise.teaching, options.facts)}
  </section>

  <section class="pane lesson-work">
    <article class="lesson-brief" id="brief">
      <h1>${escapeHtml(exercise.title)}</h1>
      ${renderMarkdown(stripRefs(exercise.brief))}
    </article>
    ${
      exercise.kind === "lab"
        ? labFormHtml(state, options, working)
        : exercise.kind === "media-lab"
          ? mediaLabFormHtml(state, options, working)
          : exercise.kind === "mutation"
            ? drillHtml(state, working)
            : exercise.kind === "refactor"
              ? refactorHtml(state, working)
              : exercise.kind === "transcript"
                ? transcriptHtml(state, options, working)
                : exercise.kind === "flaw-review"
                  ? flawReviewHtml(state, working)
                  : exercise.kind === "cache-plan"
                    ? cachePlanHtml(state, working)
                    : answerFormHtml(state, working)
    }
    <section class="answers" id="answers">${answersHtml(options.answers)}</section>
  </section>

  <aside class="pane pane-side">
    <section class="briefing" id="briefing" ${session.phase === "briefing" ? "" : "hidden"}>
      <h2>When you are ready</h2>
      <p>Read the lesson and the brief, then start the clock. Ask the interviewer anything along the way.</p>
      <div class="button-row">
        <button type="button" class="button primary" id="start-button">Start the clock</button>
      </div>
    </section>

    <section class="chat" id="chat">
      <h2>Interviewer</h2>
      <ul class="messages" id="messages">${messages}</ul>
      <form class="composer" id="composer">
        <textarea id="composer-text" rows="2" placeholder="Ask about the scenario, or explain a choice…"></textarea>
        <button type="submit" class="button">Send</button>
      </form>
    </section>

    <section class="rubric" id="rubric">${session.rubric ? lessonRubricHtml(session, options.checklist, options.survivors, options.reveal) : ""}${session.rubric && options.nextHtml ? options.nextHtml : ""}</section>

    <div class="side-footer">
      <button type="button" class="button" id="done-button" ${session.phase === "review" || session.phase === "done" ? "disabled" : ""}>I'm done</button>
    </div>
  </aside>
</main>`;

  return page({
    title: session.lessonTitle,
    bodyClass: "session lesson",
    body,
    config: {
      sessionId: session.id,
      phase: session.phase,
      timerMs: session.timerMs,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
      remainingMs: state.remainingMs,
      draft: state.draft,
      listening: state.listening,
      focus: session.focus,
      kind: exercise.kind,
      checklist: options.checklist ?? [],
    },
    module: "runtime/lesson/main.mjs",
  });
}

function answerFormHtml(state: LessonState, working: boolean): string {
  return `<form class="answer-form" id="answer-form">
      <label for="answer-text"><strong>Your answer</strong> <span class="muted small">Markdown. Draft it with your own agent if you like; what is graded is the judgement in it.</span></label>
      <textarea id="answer-text" rows="16" spellcheck="true" ${working ? "" : "disabled"}>${escapeHtml(state.draft)}</textarea>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="submit" class="button primary" id="answer-button" ${working ? "" : "disabled"}>Submit answer</button>
      </div>
    </form>`;
}

/**
 * A drill: the workspace the learner points their agent at, and the Grade button.
 * The grade shows counts only; which bugs survived waits for the debrief.
 */
function drillHtml(state: LessonState, working: boolean): string {
  const drill = state.session.drill;
  const latest = drill?.latest;
  return `<section class="drill" id="drill">
      <h2>Your workspace</h2>
      <p>Point your own agent at this folder. It holds <code>README.md</code>, <code>${escapeHtml(drill?.module ?? "module")}.py</code>, and an empty <code>tests/</code>.</p>
      <pre class="workspace-path"><code id="workspace-path">cd ${escapeHtml(drill?.workspace ?? "")}</code></pre>
      <p class="muted small">Tests are unittest files named <code>tests/test_*.py</code>; run them with <code>python3 -m unittest discover tests</code>. Grading runs them against the module, against rewrites of it that behave the same, and against copies with one planted bug each. Only <code>tests/*.py</code> is read back.</p>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="button" class="button primary" id="grade-button" ${working ? "" : "disabled"}>Grade my tests</button>
      </div>
      <div class="grade-result" id="grade-result">${latest ? gradeHtml(latest) : ""}</div>
    </section>`;
}

/**
 * A transcript review: list the learner's recent Claude Code sessions on request,
 * pick one, consent, submit. Nothing is listed until they press the button.
 */
function transcriptHtml(state: LessonState, options: LessonPageOptions, working: boolean): string {
  const checklist = (options.checklist ?? [])
    .map((c) => `<li data-item="${escapeHtml(c.id)}">${escapeHtml(c.text)}</li>`)
    .join("\n");
  const chosen = state.session.transcript;
  return `<section class="lab-checklist" id="lab-checklist">
      <h2>What the review checks</h2>
      <ul>${checklist}</ul>
    </section>
    <form class="answer-form lab-form" id="answer-form" data-transcript="true">
      <label><strong>One of your Claude Code sessions</strong> <span class="muted small">Pick a recent session where you did real work.</span></label>
      <div class="button-row"><button type="button" class="button" id="transcript-list" ${working ? "" : "disabled"}>List my recent sessions</button></div>
      <ul class="transcripts" id="transcripts">${chosen ? `<li class="muted">Submitted: a session from <code>${escapeHtml(chosen.project)}</code></li>` : ""}</ul>
      <p class="muted small">The interviewer gets a summary of the session you pick: request and token counts, models, cache reads and writes, gaps, compactions, and your first prompts with anything that looks like a credential redacted. Never the replies or tool output.</p>
      <label for="answer-text">Notes for the reviewer <span class="muted small">Optional: what the session was for.</span></label>
      <textarea id="answer-text" rows="4" spellcheck="true" ${working ? "" : "disabled"}>${escapeHtml(state.draft)}</textarea>
      <label class="consent"><input type="checkbox" id="lab-consent" disabled> Let ChudCode read the session I picked and show its summary to the interviewer.</label>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="submit" class="button primary" id="answer-button" disabled>Submit for review</button>
      </div>
    </form>`;
}

/** A refactor drill: the workspace, the two steps, and Grade. */
function refactorHtml(state: LessonState, working: boolean): string {
  const drill = state.session.drill;
  const latest = state.session.refactor?.latest;
  return `<section class="drill" id="drill">
      <h2>Your workspace</h2>
      <p>A git repository holding <code>${escapeHtml(drill?.module ?? "module")}.py</code>, a <code>README.md</code>, and an empty <code>tests/</code>. With your own agent:</p>
      <ol>
        <li>Pin what the module does now with characterisation tests in <code>tests/test_*.py</code>, and <strong>commit them</strong>.</li>
        <li>Refactor the module, keeping its public functions and parameters, and commit again.</li>
      </ol>
      <pre class="workspace-path"><code id="workspace-path">cd ${escapeHtml(drill?.workspace ?? "")}</code></pre>
      <p class="muted small">Grade reads the history, runs your tests against the original and against copies with one planted bug each, runs hidden behaviour tests on your refactor, and compares the interface and the shape before and after.</p>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="button" class="button primary" id="grade-button" ${working ? "" : "disabled"}>Grade my refactor</button>
      </div>
      <div class="grade-result" id="grade-result">${latest ? refactorGradeHtml(latest) : ""}</div>
    </section>`;
}

export function refactorGradeHtml(grade: RefactorGrade): string {
  const row = (ok: boolean, text: string) =>
    `<li><span class="badge ${ok ? "ok" : "warn"}">${ok ? "yes" : "no"}</span> ${text}</li>`;
  return `<p><span class="badge ${grade.passed ? "ok" : "warn"}">${grade.passed ? "Past the gate" : "Not yet"}</span> Grade ${grade.number}</p>
<ul class="checklist-results">
${row(grade.testsFirst, "Tests committed before the module changed")}
${row(grade.mutants > 0 && grade.killed / grade.mutants >= 0.6, `Characterisation caught ${grade.killed} of ${grade.mutants} planted bugs in the original`)}
${row(grade.behaviourKept, "Hidden behaviour tests pass on your refactor")}
${row(grade.ownTestsPass, "Your own tests pass on your refactor")}
${row(grade.apiSame, "Public functions and parameters unchanged")}
${row(grade.after.longestFunction < grade.before.longestFunction || grade.after.maxNesting < grade.before.maxNesting, `Longest function ${grade.before.longestFunction} → ${grade.after.longestFunction} lines, deepest nesting ${grade.before.maxNesting} → ${grade.after.maxNesting}`)}
</ul>`;
}

/** One grade, as counts: the bar, and what kept it from passing. */
export function gradeHtml(grade: DrillGrade): string {
  const pct = grade.mutants ? Math.round((grade.killed / grade.mutants) * 100) : 0;
  return `<p><span class="badge ${grade.passed ? "ok" : "warn"}">${grade.passed ? "Past the gate" : "Not yet"}</span> Grade ${grade.number}: ${grade.tests} tests caught <strong>${grade.killed} of ${grade.mutants}</strong> planted bugs (${pct}%).</p>
<meter min="0" max="${grade.mutants}" low="${Math.ceil(grade.mutants * 0.8) - 0.5}" optimum="${grade.mutants}" value="${grade.killed}"></meter>
${grade.problems.length ? `<ul>${grade.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""}
${grade.assertFree ? `<p class="muted small">${grade.assertFree} test${grade.assertFree === 1 ? "" : "s"} assert nothing.</p>` : ""}`;
}

/**
 * A flaw review: the diff with clickable lines, the learner's marks, and Submit.
 * Marks live in the page (and the draft) until submitted.
 */
function flawReviewHtml(state: LessonState, working: boolean): string {
  let files: DiffFile[];
  try {
    files = parseDiff(state.exercise.diff ?? "");
  } catch {
    files = [];
  }
  const review = state.session.review;
  const left = MAX_REVIEWS - (review?.grades ?? 0);
  const tables = files
    .map((file) => {
      const rows = file.lines
        .map((line) => {
          const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
          const attrs =
            line.newLine === undefined
              ? ""
              : ` data-file="${escapeHtml(file.path)}" data-line="${line.newLine}" tabindex="0"`;
          return `<tr class="diff-${line.kind}"${attrs}><td class="ln">${line.newLine ?? ""}</td><td class="sign">${sign}</td><td class="code">${escapeHtml(line.text)}</td></tr>`;
        })
        .join("");
      return `<div class="diff-file"><div class="diff-path">${escapeHtml(file.path)}</div><table class="diff"><tbody>${rows}</tbody></table></div>`;
    })
    .join("\n");
  const options = FLAW_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join("");
  return `<section class="flaw-review" id="flaw-review">
      <h2>The diff</h2>
      <p class="muted small">Click a line to mark it: what you would block the merge on, with a category and a reason. A mark within ${LINE_SLACK} lines of a problem counts. Draft the review with your own agent if you like.</p>
      ${tables}
      <form class="mark-form" id="mark-form" hidden>
        <strong id="mark-where"></strong>
        <select id="mark-category">${options}</select>
        <input type="text" id="mark-reason" maxlength="500" placeholder="Why it is wrong">
        <div class="button-row"><button type="button" class="button" id="mark-cancel">Cancel</button><button type="submit" class="button primary">Add mark</button></div>
      </form>
      <h3>Your marks</h3>
      <ol class="marks" id="marks"></ol>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="button" class="button primary" id="review-button" ${working && left > 0 ? "" : "disabled"}>Submit review</button>
      </div>
      <p class="muted small" id="reviews-left">${left} of ${MAX_REVIEWS} submissions left.</p>
      <div class="grade-result" id="review-result">${review?.latest ? reviewGradeHtml(review.latest) : ""}</div>
    </section>`;
}

export function reviewGradeHtml(grade: ReviewGrade): string {
  return `<p><span class="badge ${grade.passed ? "ok" : "warn"}">${grade.passed ? "Past the gate" : "Not yet"}</span> Review ${grade.number}: found <strong>${grade.found} of ${grade.flaws}</strong> planted flaws, ${grade.falseAlarms} false alarm${grade.falseAlarms === 1 ? "" : "s"}.</p>
${grade.problems.length ? `<ul>${grade.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""}`;
}

/**
 * A cache plan: the workload as a table and as JSON for the learner's agent, the plan
 * editor, and what the simulator says about it.
 */
function cachePlanHtml(state: LessonState, working: boolean): string {
  const scenario = state.exercise.scenario;
  if (!scenario) return "";
  const model = loadCacheModel();
  const pricing = model.models[scenario.model];
  const segments = scenario.segments
    .map(
      (s) =>
        `<tr><td><code>${escapeHtml(s.id)}</code></td><td>${s.level}</td><td class="num">${s.tokens.toLocaleString("en-US")}</td><td>${escapeHtml(s.label)}</td><td>${s.changesAt?.length ? `at request${s.changesAt.length === 1 ? "" : "s"} ${s.changesAt.join(", ")}` : "never"}</td></tr>`,
    )
    .join("");
  const times = scenario.requests.map((r) => r.at).join(", ");
  const newTokens = [...new Set(scenario.requests.map((r) => r.newTokens))];
  const skeleton = JSON.stringify(
    { order: scenario.segments.map((s) => s.id), breakpoints: [] },
    null,
    2,
  );
  const latest = state.session.cachePlan?.latest;
  return `<section class="cache-plan" id="cache-plan">
      <h2>The workload</h2>
      <p>Model <code>${escapeHtml(scenario.model)}</code>${pricing ? `: $${pricing.inputPerMTok} per million input tokens, cache reads at ${pricing.readMultiplier}×, nothing cached under ${pricing.minCacheable.toLocaleString("en-US")} tokens` : ""}. Writes cost ${model.writeMultiplier["5m"]}× for five minutes and ${model.writeMultiplier["1h"]}× for an hour; at most ${model.maxBreakpoints} breakpoints.</p>
      <table class="segments"><thead><tr><th>Segment</th><th>Level</th><th class="num">Tokens</th><th>What</th><th>Changes</th></tr></thead><tbody>${segments}</tbody></table>
      <p>${plural(scenario.requests.length, "request")}, at minute${scenario.requests.length === 1 ? "" : "s"} ${escapeHtml(times)}, each adding ${newTokens.length === 1 ? (newTokens[0] ?? 0).toLocaleString("en-US") : "its own"} new tokens after every segment.</p>
      <details><summary>The workload as JSON, for your agent</summary><pre class="scenario-json"><code>${escapeHtml(JSON.stringify(scenario, null, 2))}</code></pre></details>
      <label for="answer-text"><strong>Your plan</strong> <span class="muted small">JSON: the segment order (tools, then system, then messages) and up to ${model.maxBreakpoints} breakpoints, each 5m or 1h, longer lifetimes first.</span></label>
      <textarea id="answer-text" rows="12" spellcheck="false" ${working ? "" : "disabled"}>${escapeHtml(state.draft || skeleton)}</textarea>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="button" class="button primary" id="plan-button" ${working ? "" : "disabled"}>Check plan</button>
      </div>
      <div class="grade-result" id="plan-result">${latest ? planGradeHtml(latest) : ""}</div>
      <p class="muted small">A simplified model of prompt caching, with every price and limit from the sources cited: it leaves out output tokens and the 20-block lookback, so read it as the shape of the trade-off, not an invoice.</p>
    </section>`;
}

export function planGradeHtml(grade: CacheGrade): string {
  return `<p><span class="badge ${grade.passed ? "ok" : "warn"}">${grade.passed ? "Past the gate" : "Not yet"}</span> Plan ${grade.number}: <strong>${dollars(grade.cost)}</strong>, ${(grade.ratio * 100).toFixed(0)}% of the best plan known (the bar is ${Math.round(COST_SLACK * 100)}%).</p>
<p class="muted small">Cache hits on ${grade.hits} of ${grade.requests} requests; ${grade.readTokens.toLocaleString("en-US")} tokens read, ${grade.writeTokens.toLocaleString("en-US")} written, ${grade.uncachedTokens.toLocaleString("en-US")} uncached. With no caching: ${dollars(grade.uncachedCost)}.</p>`;
}

/** The answers a flaw review or cache plan kept back until the debrief. */
export function revealHtml(reveal: DrillReveal): string {
  if (reveal.kind === "cache-plan")
    return `<h3>The best plan known</h3><p>${dollars(reveal.referenceCost)}</p><pre><code>${escapeHtml(JSON.stringify(reveal.reference, null, 2))}</code></pre>`;
  const flaws = reveal.flaws
    .map(
      (f) =>
        `<li><span class="badge ${f.found ? "ok" : "warn"}">${f.found ? "found" : "missed"}</span> <code>${escapeHtml(f.file)}:${f.line}</code> ${escapeHtml(f.category)}${f.critical ? " (critical)" : ""}<div class="muted small">${escapeHtml(f.explanation)}</div></li>`,
    )
    .join("");
  const alarms = reveal.falseAlarms
    .map(
      (a) =>
        `<li><code>${escapeHtml(a.file)}:${a.line}</code>${a.decoy ? ` <span class="muted small">${escapeHtml(a.decoy)}</span>` : ""}</li>`,
    )
    .join("");
  return `<h3>The planted flaws</h3><ul class="checklist-results">${flaws}</ul>${alarms ? `<h3>False alarms</h3><ul>${alarms}</ul>` : ""}`;
}

/**
 * A lab's form: the project folder, the files a review would read, and the consent
 * box. Nothing is read until the learner ticks it and submits.
 */
function labFormHtml(state: LessonState, options: LessonPageOptions, working: boolean): string {
  const patterns = (options.labFiles ?? []).map((p) => `<code>${escapeHtml(p)}</code>`).join(", ");
  const checklist = (options.checklist ?? [])
    .map((c) => `<li data-item="${escapeHtml(c.id)}">${escapeHtml(c.text)}</li>`)
    .join("\n");
  return `<section class="lab-checklist" id="lab-checklist">
      <h2>What the review checks</h2>
      <ul>${checklist}</ul>
    </section>
    <form class="answer-form lab-form" id="answer-form" data-lab="true">
      <label for="lab-path"><strong>Your project</strong> <span class="muted small">The folder you worked in with your agent.</span></label>
      <div class="lab-path-row">
        <input type="text" id="lab-path" autocomplete="off" spellcheck="false" placeholder="~/code/my-project" value="${escapeHtml(state.session.lab?.root ?? "")}" ${working ? "" : "disabled"}>
        <button type="button" class="button" id="lab-preview" ${working ? "" : "disabled"}>Show the files</button>
      </div>
      <p class="muted small">A review reads only ${patterns}, read-only, from that folder. It never follows a link out of it, never reads <code>.env</code> files or keys, and redacts anything that looks like a credential before the interviewer sees it.</p>
      <ul class="lab-files" id="lab-files" aria-live="polite"></ul>
      <label for="answer-text">Notes for the reviewer <span class="muted small">Optional: what you changed and why.</span></label>
      <textarea id="answer-text" rows="5" spellcheck="true" ${working ? "" : "disabled"}>${escapeHtml(state.draft)}</textarea>
      <label class="consent"><input type="checkbox" id="lab-consent" disabled> Let ChudCode read the files listed above and show them to the interviewer.</label>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="submit" class="button primary" id="answer-button" disabled>Submit for review</button>
      </div>
    </form>`;
}

const CHECK_ORDER: Record<string, number> = { fail: 0, warn: 1, pass: 2 };
const CHECK_LABEL: Record<string, string> = { fail: "Fails", warn: "Warning", pass: "Passes" };

/**
 * A media lab's latest measurement: every check that applied, failures first, with
 * the file and line of each problem. The page script renders the same markup live.
 */
export function mediaResultsHtml(checks: readonly CheckResult[] | null | undefined): string {
  if (!checks) return "";
  const shown = checks
    .filter((c) => c.status !== "n/a")
    .sort((a, b) => (CHECK_ORDER[a.status] ?? 3) - (CHECK_ORDER[b.status] ?? 3));
  const failed = shown.filter((c) => c.status === "fail").length;
  const summary =
    failed === 0
      ? "Every fail-level check passed."
      : `${plural(failed, "check")} must pass before the lesson can: fix ${failed === 1 ? "it" : "them"} and submit again.`;
  const items = shown
    .map(
      (c) =>
        `<li class="check check-${c.status}"><span class="badge ${c.status === "pass" ? "ok" : "warn"}">${CHECK_LABEL[c.status]}</span> ${escapeHtml(c.title)}${c.findings.length ? `<ul class="findings">${c.findings.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join("")}</ul>` : ""}</li>`,
    )
    .join("\n");
  return `<h2>Measured</h2><p>${summary}</p><ul class="media-checks">${items}</ul>`;
}

/**
 * A media lab's form: the repository with the site and media, what would be
 * measured, and the consent box. It reuses the lab's ids so the page script and the
 * routes are shared; nothing is opened until the learner ticks it and submits.
 */
function mediaLabFormHtml(
  state: LessonState,
  options: LessonPageOptions,
  working: boolean,
): string {
  const checklist = (options.checklist ?? [])
    .map((c) => `<li data-item="${escapeHtml(c.id)}">${escapeHtml(c.text)}</li>`)
    .join("\n");
  return `<section class="lab-checklist" id="lab-checklist">
      <h2>What the review checks</h2>
      <ul>${checklist}</ul>
    </section>
    <section class="media-results" id="media-results" ${options.mediaChecks ? "" : "hidden"}>${mediaResultsHtml(options.mediaChecks)}</section>
    <form class="answer-form lab-form" id="answer-form" data-lab="true" data-media="true">
      <label for="lab-path"><strong>Your project</strong> <span class="muted small">The repository with your site, README, and demo media.</span></label>
      <div class="lab-path-row">
        <input type="text" id="lab-path" autocomplete="off" spellcheck="false" placeholder="~/code/my-app" value="${escapeHtml(state.session.lab?.root ?? "")}" ${working ? "" : "disabled"}>
        <button type="button" class="button" id="lab-preview" ${working ? "" : "disabled"}>Show the files</button>
      </div>
      <p class="muted small">A review reads the HTML pages at the root or in <code>docs/</code>, <code>site/</code>, <code>public/</code>, or <code>web/</code>, the README, and the headers of the images and videos in the project, read-only. It never follows a link out of the folder or reads <code>.env</code> files or keys. Up to three images under 1 MB (the social preview, a poster, a screenshot) are shown to the interviewer.</p>
      <ul class="lab-files" id="lab-files" aria-live="polite"></ul>
      <label for="answer-text">Notes for the reviewer <span class="muted small">Optional: the live URL, and what you changed.</span></label>
      <textarea id="answer-text" rows="5" spellcheck="true" ${working ? "" : "disabled"}>${escapeHtml(state.draft)}</textarea>
      <label class="consent"><input type="checkbox" id="lab-consent" disabled> Let ChudCode measure the files listed above and show three of the images to the interviewer.</label>
      <div class="button-row">
        <span class="save-state" id="save-state"></span>
        <button type="submit" class="button primary" id="answer-button" disabled>Submit for review</button>
      </div>
    </form>`;
}

/** The teaching with each `[fact:<id>]` as a numbered link to its source below. */
export function teachingHtml(markdown: string, facts: readonly FactFreshness[]): string {
  const order: FactFreshness[] = [];
  const withRefs = markdown.replace(FACT_REF, (whole, id: string) => {
    const entry = facts.find((f) => f.fact.id === id);
    if (!entry) return "";
    if (!order.includes(entry)) order.push(entry);
    const n = order.indexOf(entry) + 1;
    return `<sup class="fact-ref"><a href="#fact-${id}" title="${escapeHtml(entry.fact.claim)}">${n}</a></sup>`;
  });
  const sources = order
    .map((entry) => {
      const checked = new Date(entry.confirmedAt).toISOString().slice(0, 10);
      const flag = entry.problem
        ? ` <span class="badge warn">${escapeHtml(entry.problem.status)} when last checked</span>`
        : "";
      return `<li id="fact-${escapeHtml(entry.fact.id)}">${escapeHtml(entry.fact.claim)} <a href="${escapeHtml(entry.fact.source)}" target="_blank" rel="noopener noreferrer">Source</a> <span class="muted small">checked ${checked}</span>${flag}</li>`;
    })
    .join("\n");
  return `${renderMarkdown(withRefs)}
${sources ? `<h2>Sources</h2>\n<ol class="fact-sources">\n${sources}\n</ol>` : ""}`;
}

function stripRefs(markdown: string): string {
  return markdown.replace(FACT_REF, "");
}

function answersHtml(answers: readonly string[]): string {
  if (answers.length === 0) return "";
  return `<h2>Submitted</h2>
${answers
  .map(
    (text, i) =>
      `<details class="answer"${i === answers.length - 1 ? " open" : ""}><summary>Answer ${i + 1}</summary><div class="answer-body">${renderMarkdown(text)}</div></details>`,
  )
  .join("\n")}`;
}

export function lessonRubricHtml(
  session: LessonSession,
  items: readonly ChecklistItem[] = [],
  survivors: ReadonlyArray<{ id: string; description: string }> = [],
  reveal: DrillReveal | null = null,
): string {
  const r = session.rubric;
  if (!r) return "";
  const rows = LESSON_DIMENSION_NAMES.map(([key, label]) => {
    const score = r[key];
    const focus = session.focus.includes(key) ? ` <span class="muted small">focus</span>` : "";
    const value =
      score === null || score === undefined
        ? `<span class="muted">n/a</span>`
        : `${"●".repeat(score)}${"○".repeat(4 - score)}`;
    return `<li><span>${label}${focus}</span><span class="score">${value}</span></li>`;
  }).join("\n  ");
  const passed = session.verdict?.correct;
  return `<h2>Debrief <span class="badge ${passed ? "ok" : "warn"}">${passed ? "Passed" : "Not yet"}</span></h2>
<ul class="scores">
  ${rows}
</ul>
<div class="rubric-notes">${renderMarkdown(r.notesMd)}</div>
${r.checklist?.length ? `<h3>Checklist</h3><ul class="checklist-results">${r.checklist.map((c) => `<li class="check-${c.status}"><span class="badge ${c.status === "met" ? "ok" : "warn"}">${c.status}</span> ${escapeHtml(items.find((i) => i.id === c.id)?.text ?? c.id)}<div class="muted small">${escapeHtml(c.note)}</div></li>`).join("")}</ul>` : ""}
${r.strengths.length ? `<h3>Strengths</h3><ul>${r.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}
${session.exerciseKind === "mutation" || session.exerciseKind === "refactor" ? survivorsHtml(survivors) : ""}
${reveal ? revealHtml(reveal) : ""}
${r.improvements.length ? `<h3>Work on</h3><ul>${r.improvements.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : ""}`;
}

/** The planted bugs a drill's tests missed, shown once the lesson is scored. */
export function survivorsHtml(
  survivors: ReadonlyArray<{ id: string; description: string }>,
): string {
  if (survivors.length === 0) return `<h3>Planted bugs</h3><p>Your tests caught every one.</p>`;
  return `<h3>Bugs your tests missed</h3><ul class="survivors">${survivors.map((m) => `<li>${escapeHtml(m.description)}</li>`).join("")}</ul>`;
}
