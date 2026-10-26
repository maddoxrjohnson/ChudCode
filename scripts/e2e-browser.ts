/**
 * Browser end-to-end check: drive the real interview page in headless Chromium
 * against the real server, with a scripted interviewer standing in for the agent.
 *
 *   npm run e2e:browser [-- <screenshot directory>]
 *
 * Run `npx playwright install chromium` once first. State lives in a throwaway
 * directory. This covers what the unit tests cannot: the editor, autosave, the Run
 * and Submit buttons, custom input, the hint ladder, the chat in both directions,
 * the debrief card arriving over SSE, the dashboard reflecting the scored session and
 * reloading when another one starts, the Next problem button following the
 * interviewer to the session it opens, an agentic-coding lesson from its sourced
 * teaching to the debrief, a lab that reads a project the learner consents to, and
 * a mutation drill graded twice, a flaw review marked line by line, and a cache plan.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { chromium, type Page } from "playwright";

import { notifyDashboard, postMessage, recordSession, startSession } from "../src/flow.ts";
import { resolveNext } from "../src/next-up.ts";
import { setHooks, type CandidateEvent, type NextRequest } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { updateMeta } from "../src/store/problems.ts";
import { readReviewEvents } from "../src/store/review-events.ts";
import { createSession, readDraft, readSession } from "../src/store/sessions.ts";
import { loadCurriculumProgress } from "../src/curriculum.ts";
import { askQuestion, postPhoneMessage, recordPhone } from "../src/phone-flow.ts";
import {
  createPhoneSession,
  phoneExists,
  readPhoneSession,
  recordBriefs,
} from "../src/store/phone.ts";
import {
  inspectLab,
  inspectMediaLab,
  postLessonMessage,
  recordLesson,
} from "../src/lesson-flow.ts";
import { updateExerciseMeta, writeExercise } from "../src/store/exercises.ts";
import { createLesson, lessonExists, readLesson, updateLesson } from "../src/store/lessons.ts";
import { createWorkspace } from "../src/drill/workspace.ts";
import { makeFixture, seedExample } from "../test/helpers.ts";
import { exerciseArgs, labArgs, mediaLabArgs } from "../test/lesson-fixtures.ts";
import { writeSite } from "../test/media-site.ts";
import { drillArgs, ORACLE, SPEC, WEAK_TESTS } from "../test/mutation-fixtures.ts";
import { cacheArgs, REFERENCE, SCENARIO } from "../test/cache-fixtures.ts";
import { FLAW_SPEC, flawArgs } from "../test/flaw-fixtures.ts";

process.env["CHUDCODE_AUTO_OPEN"] = "0";

const CORRECT = [
  "def max_window_sum(nums, k):",
  "    if k > len(nums):",
  "        return 0",
  "    window = sum(nums[:k])",
  "    best = window",
  "    for i in range(k, len(nums)):",
  "        window += nums[i] - nums[i - k]",
  "        best = max(best, window)",
  "    return best",
  "",
].join("\n");

const artifacts = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (artifacts) fs.mkdirSync(artifacts, { recursive: true });

const passed: string[] = [];
function check(name: string, condition: boolean, detail?: unknown): void {
  if (!condition) throw new Error(`${name}${detail === undefined ? "" : `: ${String(detail)}`}`);
  passed.push(name);
}

// ── The scripted interviewer ──────────────────────────────────────────────────

let solved = false;
function interviewer(event: CandidateEvent): void {
  const id = event.sessionId;
  if (lessonExists(id)) return lessonInterviewer(event);
  if (phoneExists(id)) return phoneInterviewer(event);
  switch (event.kind) {
    case "started":
      postMessage(id, "interviewer", "Hi, I'm your interviewer today. Ask me anything as you go.");
      return;
    case "message":
      if (solved) {
        recordSession(id, {
          rubric: { correctness: 4, communication: 3, complexity: 3, codeQuality: 3, time: 4 },
          complexityOk: true,
          notesMd: "A clean sliding window, stated before it was coded.",
          strengths: ["Named the invariant before coding.", "Checked k against the length."],
          improvements: [
            "Say the space complexity without being asked.",
            "Run the examples once before submitting.",
          ],
        });
      } else {
        postMessage(
          id,
          "interviewer",
          "Good question. **k is at least 1** and at most the length.",
        );
      }
      return;
    case "submission":
      if (event.result.status === "ok" && event.result.passed === event.result.total) {
        solved = true;
        postMessage(id, "interviewer", "Every case passed. What is the time complexity?");
      }
      return;
    default:
      return;
  }
}

let followedUp = false;
function lessonInterviewer(event: CandidateEvent): void {
  const id = event.sessionId;
  if (readLesson(id).exerciseKind === "lab") return labInterviewer(event);
  if (readLesson(id).exerciseKind === "media-lab") return mediaInterviewer(event);
  if (readLesson(id).exerciseKind === "mutation") return drillInterviewer(event);
  const kind = readLesson(id).exerciseKind;
  if (kind === "flaw-review" || kind === "cache-plan") {
    // Score the first submission: the page work is what this checks.
    if (event.kind === "answer")
      recordLesson(id, {
        scores: {
          decomposition: null,
          verification: 3,
          contextCost: 3,
          safety: 3,
          delegation: null,
          presentation: null,
        },
        notesMd: "Graded on the first submission.",
        strengths: ["Went straight for the risky lines."],
        improvements: ["Say what an attacker controls."],
      });
    return;
  }
  switch (event.kind) {
    case "started":
      postLessonMessage(id, "interviewer", "Take your time. Ask me anything about the scenario.");
      return;
    case "answer":
      followedUp = true;
      postLessonMessage(
        id,
        "interviewer",
        "How would you know the parser refactor changed **nothing**?",
      );
      return;
    case "message":
      if (!followedUp) return;
      recordLesson(id, {
        scores: {
          decomposition: 3,
          verification: 3,
          contextCost: null,
          safety: 2,
          delegation: null,
          presentation: null,
        },
        notesMd: "Pinned behaviour before changing it, and every phase ends in a check.",
        strengths: ["Characterisation tests come first.", "Phases are small enough to review."],
        improvements: ["Say which phase you would not run unattended."],
      });
      return;
    default:
      return;
  }
}

/** A lab: read the project when it arrives, ask about it, then score the checklist. */
function labInterviewer(event: CandidateEvent): void {
  const id = event.sessionId;
  switch (event.kind) {
    case "answer":
      void inspectLab(id).then((snapshot) =>
        postLessonMessage(
          id,
          "interviewer",
          `I read ${snapshot.files.map((f) => f.path).join(", ")}. Where does a fresh session find **the next step**?`,
        ),
      );
      return;
    case "message":
      recordLesson(id, {
        scores: {
          decomposition: 2,
          verification: null,
          contextCost: 3,
          safety: null,
          delegation: null,
          presentation: null,
        },
        notesMd: "A short CLAUDE.md that holds only what the code cannot show.",
        strengths: ["Commands and quirks only."],
        improvements: ["End progress.md with the next step."],
        checklist: [
          { id: "non-inferable", status: "met", note: "CLAUDE.md: make test, UTC dates" },
          { id: "short", status: "met", note: "4 lines" },
          { id: "no-duplication", status: "met", note: "Nothing the code shows" },
          { id: "progress-next", status: "partial", note: "progress.md has no next step" },
        ],
      });
      return;
    default:
      return;
  }
}

/** A phone screen: one question, one follow-up, then score when the learner hangs up. */
function phoneInterviewer(event: CandidateEvent): void {
  const id = event.sessionId;
  switch (event.kind) {
    case "started":
      postPhoneMessage(id, "interviewer", "Hi, thanks for making the time. Let's start.");
      askQuestion(id, "Tell me about yourself.");
      return;
    case "answer":
      if (readPhoneSession(id).questions[0]?.replies.length === 1)
        postPhoneMessage(id, "interviewer", "And why **this** company?");
      return;
    case "candidate_done":
      recordPhone(id, {
        scores: { clarity: 3, concision: 2, specificity: 3, motivation: 2 },
        answers: [{ n: 1, score: 3, note: "Clear arc; the company reason was generic." }],
        notesMd: "Name one thing only this company does.",
        strengths: ["A clear arc"],
        improvements: ["A company-specific reason"],
      });
      return;
    default:
      return;
  }
}

/** A media lab: measure each submission, then score once the gate is clear. */
function mediaInterviewer(event: CandidateEvent): void {
  const id = event.sessionId;
  switch (event.kind) {
    case "answer": {
      const snapshot = inspectMediaLab(id);
      const failed = snapshot.checks.filter((c) => c.status === "fail").length;
      postLessonMessage(
        id,
        "interviewer",
        failed
          ? `I measured the site: ${failed} checks fail. Start with the **autoplaying video**.`
          : "Every check passes now. What does a visitor see before the first frame?",
      );
      return;
    }
    case "message":
      if (!readLesson(id).lab?.gatePassed) return;
      recordLesson(id, {
        scores: {
          decomposition: null,
          verification: 3,
          contextCost: null,
          safety: null,
          delegation: null,
          presentation: 3,
        },
        notesMd: "The demo plays inline with a poster, and the preview image names the app.",
        strengths: ["Faststart H.264 demo"],
        improvements: ["Add a captions track."],
        checklist: ["deploys", "paths", "video", "first-screen"].map((item) => ({
          id: item,
          status: "met" as const,
          note: "docs/index.html",
        })),
      });
      return;
    default:
      return;
  }
}

/** A drill: ask about the first grade, score after the second. */
function drillInterviewer(event: CandidateEvent): void {
  if (event.kind !== "answer") return;
  const id = event.sessionId;
  if (event.number === 1) {
    postLessonMessage(
      id,
      "interviewer",
      "What happens when a request costs **exactly** what is left?",
    );
    return;
  }
  recordLesson(id, {
    scores: {
      decomposition: null,
      verification: 3,
      contextCost: null,
      safety: null,
      delegation: null,
      presentation: null,
    },
    notesMd: "The second suite pins the boundaries.",
    strengths: ["Exact-cost boundary"],
    improvements: ["Start from the edges next time."],
  });
}

/** A press of Next problem: the interviewer opens a session for the next step. */
function nextProblem(request: NextRequest): void {
  const next = createSession({
    problem: "window-sum",
    problemTitle: "Largest Window Sum",
    patterns: ["sliding-window"],
    difficulty: "easy",
    mode: "roadmap",
    roadmap: request.roadmap,
    timerMs: 5 * 60_000,
  });
  resolveNext(next);
  notifyDashboard(next.id);
}

// ── The run ───────────────────────────────────────────────────────────────────

const fixture = makeFixture();
seedExample();
// Written as a mimic of a listed problem, so the scored session shows on the roadmaps.
updateMeta("window-sum", {
  source: { kind: "mimic", mimicOf: "Best Time to Buy and Sell Stock" },
});
setHooks({
  isListening: () => true,
  // Reply after the request that raised the event has been answered, as an agent would.
  onCandidateEvent: (event) => void setTimeout(() => interviewer(event), 50),
  // An agent takes a moment to answer, so the page shows that it is waiting.
  onNextRequested: (request) => void setTimeout(() => nextProblem(request), 300),
});

const session = createSession({
  problem: "window-sum",
  problemTitle: "Largest Window Sum",
  patterns: ["sliding-window"],
  difficulty: "easy",
  mode: "roadmap",
  roadmap: "neetcode150",
  timerMs: 5 * 60_000,
});

const base = await server.start({ port: 0 });
const browser = await chromium.launch();
const errors: string[] = [];

async function screenshot(page: Page, name: string): Promise<void> {
  if (!artifacts) return;
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
}

try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("dialog", (dialog) => void dialog.accept());

  // Briefing: the page renders, the editor mounts, nothing runs before Start.
  await page.goto(`${base}/s/${session.id}`);
  await page.locator(".cm-editor").waitFor();
  check("session page renders", (await page.title()).startsWith("Largest Window Sum"));
  check("run is disabled before Start", await page.locator("#run-button").isDisabled());
  check("phase shows Briefing", (await page.locator("#phase").innerText()) === "Briefing");
  check(
    "the page shows the stub, not the reference",
    (await page.locator(".cm-content").innerText()).includes("def max_window_sum") &&
      !(await page.content()).includes("window += nums[i]"),
  );

  // Approach note and Start: the clock starts, both sides of the chat appear.
  await page
    .locator("#approach-text")
    .fill("Running sum over a window of k; slide and keep the best.");
  await page.locator("#start-button").click();
  await page.locator("#phase").filter({ hasText: "Coding" }).waitFor();
  await page.locator(".message.from-candidate", { hasText: "Approach:" }).waitFor();
  await page.locator(".message.from-interviewer", { hasText: "your interviewer" }).waitFor();
  check("Start moves to Coding and the note reaches the chat", true);
  check("run is enabled after Start", await page.locator("#run-button").isEnabled());

  // Typing: replace the stub, autosave lands on disk.
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(CORRECT);
  await page.locator("#save-state", { hasText: "Saved" }).waitFor();
  check("autosave writes the draft", (readDraft(session.id) ?? "").includes("window += nums[i]"));

  // Run: the visible examples stream in as rows.
  await page.locator("#run-button").click();
  await page.locator("#tests-summary", { hasText: "Ran: 3/3 passed" }).waitFor();
  check("Run executes the examples", (await page.locator("#case-list .case").count()) === 3);
  check("every example passed", (await page.locator("#case-list .status-pass").count()) === 3);
  await screenshot(page, "session-ran");

  // Custom input.
  await page.locator("#custom-input-toggle").click();
  await page.locator("#custom-input-text").fill('{"nums": [5, 5], "k": 2}');
  await page.locator("#custom-input button[type=submit]").click();
  await page.locator("#tests-summary", { hasText: "Ran: 1/1 passed" }).waitFor();
  check(
    "custom input runs as its own case",
    (await page.locator("#case-list .case-label").first().innerText()) === "Custom 1",
  );

  // Chat: a clarifying question gets an answer, rendered from Markdown.
  await page.locator("#composer-text").fill("Can k be zero?");
  await page.locator("#composer button[type=submit]").click();
  await page.locator(".message.from-candidate", { hasText: "Can k be zero?" }).waitFor();
  const reply = page.locator(".message.from-interviewer", { hasText: "at least 1" });
  await reply.waitFor();
  check(
    "interviewer replies arrive as HTML",
    (await reply.innerHTML()).includes("<strong>k is at least 1</strong>"),
  );

  // Hint: confirmed, shown, counted.
  await page.locator("#hint-button").click();
  await page.locator("#hint-list .hint", { hasText: "Hint 1" }).waitFor();
  const hintLabel = await page.locator("#hint-button").innerText();
  check("hint button counts the reveal", hintLabel === "Hint (1/3 used)", hintLabel);
  check("hint is recorded on the session", readSession(session.id).hintsUsed.join() === "1");

  // Submit: every case, hidden ones by label only; the interviewer follows up.
  await page.locator("#submit-button").click();
  await page.locator("#tests-summary", { hasText: "Submitted: 12/12 passed" }).waitFor();
  check(
    "hidden cases stay hidden",
    (await page.locator("#case-list .case .muted.small", { hasText: "hidden" }).count()) === 9,
  );
  check("hidden inputs never reach the page", !(await page.content()).includes("2477188"));
  await page.locator(".message.from-interviewer", { hasText: "time complexity" }).waitFor();

  // Debrief: the answer triggers record_session; the rubric card arrives over SSE.
  await page.locator("#composer-text").fill("O(n) time, O(1) extra space.");
  await page.locator("#composer button[type=submit]").click();
  await page.locator("#rubric", { hasText: "Debrief" }).waitFor();
  const verdict = await page.locator("#rubric .badge").textContent();
  check("the debrief card says Solved", verdict === "Solved", verdict);
  const debrief = await page.locator("#rubric").innerText();
  check(
    "the debrief names the next review",
    debrief.includes("comes back for review in 3 days"),
    debrief,
  );
  await page.locator("#phase").filter({ hasText: "Finished" }).waitFor();
  const nextRow = page.locator("#next-section .next-up");
  await nextRow.waitFor();
  check(
    "the debrief offers the next roadmap problem",
    (await nextRow.innerText()).includes("Next on NeetCode 150:") &&
      (await nextRow.locator(".next-button").isEnabled()),
    await nextRow.innerText(),
  );
  check(
    "finishing disables the buttons",
    (await page.locator("#run-button").isDisabled()) &&
      (await page.locator("#hint-button").isDisabled()),
  );
  await screenshot(page, "session-debrief");

  // Reload: everything above was also persisted and is rendered by the server.
  await page.reload();
  await page.locator(".cm-editor").waitFor();
  const rubricText = (await page.locator("#rubric").textContent()) ?? "";
  const messageCount = await page.locator(".message").count();
  check(
    "a reload shows the debrief and the conversation",
    rubricText.includes("Debrief") && messageCount >= 5,
    `${messageCount} messages; ${rubricText.slice(0, 60)}`,
  );

  // Dashboard: the scored session moved its pattern and started the streak.
  await page.goto(base);
  const streak = await page.locator("#stat-streak .stat-value").innerText();
  check("streak is 1", streak === "1", streak);
  const scored = await page.locator("#stat-sessions .stat-value").innerText();
  check("one session scored", scored === "1", scored);
  const row = page.locator('tr[data-pattern="sliding-window"]');
  check(
    "sliding-window moved to box 1",
    (await row.getAttribute("data-box")) === "1" &&
      (await row.locator("td.box.current").count()) === 1,
  );
  const dueEmpty = await page.locator("#due-empty").innerText();
  check("nothing is due yet", dueEmpty.includes("Next up: Sliding Window in 3 days"), dueEmpty);
  check(
    "the session is listed as solved",
    (await page.locator("#sessions .badge.ok").count()) === 1,
  );
  const stage = page.locator('#roadmap-neetcode150 li[data-stage="sliding-window"]');
  check(
    "the roadmap checks off the problem the session mimicked",
    // Closed <details> render nothing, so read text content, not rendered text.
    (await stage.locator(".stage-count").textContent()) === "1/6" &&
      ((await stage.locator("li.item.solved").textContent()) ?? "").includes(
        "Best Time to Buy and Sell Stock",
      ),
  );
  const grindBadge = await page.locator("#roadmap-grind75 > summary .badge").innerText();
  check("it counts on Grind 75 too", grindBadge === "1/75 solved", grindBadge);
  await screenshot(page, "dashboard");

  // Live reload: another session starting makes the open dashboard refresh itself.
  const second = createSession({ ...session, timerMs: 60_000, problemTitle: "Largest Window Sum" });
  const reloaded = page.waitForEvent("load");
  startSession(second.id);
  await reloaded;
  check(
    "the dashboard reloads when a session starts",
    (await page.locator("#sessions tbody tr").count()) === 2,
  );

  // Next problem: a press waits for the interviewer, then follows it to the new session.
  const neetNext = page.locator('.next-up[data-roadmap="neetcode150"]');
  check(
    "the dashboard names the next NeetCode 150 problem",
    ((await neetNext.textContent()) ?? "").includes("Contains Duplicate"),
    await neetNext.textContent(),
  );
  await neetNext.locator(".next-button").click();
  await page.locator('.next-up[data-roadmap="neetcode150"][data-state="waiting"]').waitFor();
  check("a press shows that it is waiting", true);
  await page.waitForURL(/\/s\/\d{8}-\d{4}-window-sum-[0-9a-f]{4}$/);
  await page.locator(".cm-editor").waitFor();
  check(
    "the press lands on the session the interviewer opened",
    (await page.locator("#phase").innerText()) === "Briefing" &&
      !page.url().endsWith(session.id) &&
      !page.url().endsWith(second.id),
    page.url(),
  );

  // An agentic-coding lesson: sourced teaching, an answer, a follow-up, the debrief.
  const exercise = exerciseArgs();
  writeExercise({
    meta: {
      slug: exercise["slug"] as string,
      kind: "design-review",
      lesson: "plan-before-code",
      title: exercise["title"] as string,
      createdAt: Date.now(),
      timesServed: 0,
    },
    teaching: exercise["teaching_md"] as string,
    brief: exercise["brief_md"] as string,
    private: {
      modelOutline: exercise["model_outline"] as string,
      followUps: exercise["follow_ups"] as string[],
      pitfalls: exercise["pitfalls"] as string[],
    },
  });
  updateExerciseMeta("plan-ofx-import", { validatedAt: Date.now() });
  const lesson = createLesson({
    lesson: "plan-before-code",
    lessonTitle: "Explore, plan, then code",
    module: "planning",
    exercise: "plan-ofx-import",
    exerciseKind: "design-review",
    focus: ["decomposition", "verification"],
    timerMs: 45 * 60_000,
  });
  await page.goto(`${base}/s/${lesson.id}`);
  check("the lesson page renders", (await page.title()).startsWith("Explore, plan, then code"));
  check("it shows no code editor", (await page.locator(".cm-editor").count()) === 0);
  check(
    "teaching cites its sources",
    (await page.locator(".fact-sources li").count()) === 3 &&
      (await page.locator(".fact-ref a").count()) === 3,
  );
  check("the answer box waits for Start", await page.locator("#answer-text").isDisabled());
  await page.locator("#start-button").click();
  await page.locator("#phase", { hasText: "Working" }).waitFor();
  await page
    .locator(".message.from-interviewer", { hasText: "Ask me anything about the scenario" })
    .waitFor();
  check("Start reaches the interviewer, who greets the learner", true);
  await page
    .locator("#answer-text")
    .fill(
      "1. Pin today's CSV parsing with tests on real exports from both banks.\n2. Extract a parser interface; the suite stays green.\n3. Add OFX behind it with fixtures.\n4. Wire the CLI flag.",
    );
  await screenshot(page, "lesson");
  await page.locator("#answer-button").click();
  await page.locator(".answers .answer summary", { hasText: "Answer 1" }).waitFor();
  check("the submitted answer is listed", true);
  await page.locator(".message.from-interviewer", { hasText: "changed nothing" }).waitFor();
  check("the interviewer follows up on the answer", true);
  await page.locator("#composer-text").fill("The phase 0 tests run unchanged before and after.");
  await page.locator("#composer button[type=submit]").click();
  const lessonVerdict = await page.locator("#rubric .badge").textContent({ timeout: 5000 });
  check("the lesson debrief says Passed", lessonVerdict === "Passed", lessonVerdict);
  check(
    "the debrief has no stray text",
    !(await page.locator("#rubric").innerText()).includes("null"),
  );
  check(
    "unscored dimensions show as n/a",
    (await page.locator("#rubric .scores li", { hasText: "n/a" }).count()) === 3,
  );
  await page.locator("#rubric .next-up", { hasText: "Next lesson" }).waitFor({ timeout: 5000 });
  check("the debrief offers the next lesson", true);
  await screenshot(page, "lesson-debrief");
  await page.goto(base);
  const lessonsBadge = await page.locator("#agentic .badge").first().textContent();
  check(
    "the dashboard counts the passed lesson",
    lessonsBadge === `1/${loadCurriculumProgress().total} lessons passed`,
    lessonsBadge,
  );

  // A lab: the learner names their project, sees what would be read, and consents.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-e2e-lab-")));
  fs.writeFileSync(
    path.join(project, "CLAUDE.md"),
    "# Ledger\n\nRun `make test`.\nDates are UTC.\n",
  );
  fs.writeFileSync(path.join(project, "progress.md"), "Done: OFX parser.\n");
  fs.writeFileSync(path.join(project, ".env"), "TOKEN=never-read");
  const lab = labArgs();
  writeExercise({
    meta: {
      slug: lab["slug"] as string,
      kind: "lab",
      lesson: "context-files",
      title: lab["title"] as string,
      createdAt: Date.now(),
      timesServed: 0,
    },
    teaching: lab["teaching_md"] as string,
    brief: lab["brief_md"] as string,
    private: {
      modelOutline: lab["model_outline"] as string,
      followUps: lab["follow_ups"] as string[],
      pitfalls: lab["pitfalls"] as string[],
    },
  });
  updateExerciseMeta("tighten-your-claude-md", { validatedAt: Date.now() });
  const labSession = createLesson({
    lesson: "context-files",
    lessonTitle: "CLAUDE.md, AGENTS.md, and progress files",
    module: "planning",
    exercise: "tighten-your-claude-md",
    exerciseKind: "lab",
    focus: ["contextCost", "decomposition"],
    timerMs: 45 * 60_000,
  });
  await page.goto(`${base}/s/${labSession.id}`);
  check(
    "the lab page lists what the review checks",
    (await page.locator("#lab-checklist li").count()) === 4,
  );
  await page.locator("#start-button").click();
  await page.locator("#phase", { hasText: "Working" }).waitFor();
  check(
    "submit waits for a preview and consent",
    await page.locator("#answer-button").isDisabled(),
  );
  await page.locator("#lab-path").fill(project);
  await page.locator("#lab-preview").click();
  await page.locator("#lab-files li", { hasText: "progress.md" }).waitFor();
  const listed = await page.locator("#lab-files li").allTextContents();
  check(
    "the preview lists only the lab's files",
    listed.length === 2 && listed.every((l) => !l.includes(".env")),
    listed.join(" | "),
  );
  check("submit still waits for consent", await page.locator("#answer-button").isDisabled());
  await page.locator("#lab-consent").check();
  await page.locator("#answer-text").fill("Cut CLAUDE.md to the commands.");
  await screenshot(page, "lab");
  await page.locator("#answer-button").click();
  await page.locator(".answers .answer summary", { hasText: "Answer 1" }).waitFor();
  await page.locator(".message.from-interviewer", { hasText: "I read" }).waitFor();
  check("the interviewer reads the project and asks about it", true);
  await page.locator("#composer-text").fill("It doesn't yet; I'll add a Next section.");
  await page.locator("#composer button[type=submit]").click();
  const labVerdict = await page.locator("#rubric .badge").first().textContent({ timeout: 5000 });
  check("the lab debrief arrives", labVerdict === "Passed", labVerdict);
  check(
    "the debrief shows every checklist result",
    (await page.locator("#rubric .checklist-results li").count()) === 4,
  );
  await screenshot(page, "lab-debrief");
  fs.rmSync(project, { recursive: true, force: true });

  // A media lab: the site and media are measured; a failed check blocks the pass.
  const site = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chudcode-e2e-site-")));
  writeSite(site, "bad");
  const media = mediaLabArgs();
  writeExercise({
    meta: {
      slug: media["slug"] as string,
      kind: "media-lab",
      lesson: "pages-site",
      title: media["title"] as string,
      createdAt: Date.now(),
      timesServed: 0,
    },
    teaching: media["teaching_md"] as string,
    brief: media["brief_md"] as string,
    private: {
      modelOutline: media["model_outline"] as string,
      followUps: media["follow_ups"] as string[],
      pitfalls: media["pitfalls"] as string[],
    },
  });
  updateExerciseMeta("ship-your-pages-site", { validatedAt: Date.now() });
  const mediaSession = createLesson({
    lesson: "pages-site",
    lessonTitle: "A GitHub Pages site for your app",
    module: "showcase",
    exercise: "ship-your-pages-site",
    exerciseKind: "media-lab",
    focus: ["verification", "presentation"],
    timerMs: 45 * 60_000,
  });
  await page.goto(`${base}/s/${mediaSession.id}`);
  check(
    "the media lab page lists what the review checks",
    (await page.locator("#lab-checklist li").count()) === 4,
  );
  await page.locator("#start-button").click();
  await page.locator("#phase", { hasText: "Working" }).waitFor();
  await page.locator("#lab-path").fill(site);
  await page.locator("#lab-preview").click();
  await page.locator("#lab-files li", { hasText: "docs/index.html" }).waitFor();
  const measured = await page.locator("#lab-files li").allTextContents();
  check(
    "the media preview lists pages and media, never .env",
    measured.some((l) => l.includes("slow.mp4")) && measured.every((l) => !l.includes(".env")),
    measured.join(" | "),
  );
  await page.locator("#lab-consent").check();
  await page.locator("#answer-button").click();
  await page.locator("#media-results .check-fail").first().waitFor();
  check(
    "the measurement lists the failed checks first",
    (await page.locator("#media-results .media-checks > li").first().getAttribute("class")) ===
      "check check-fail",
  );
  check(
    "a finding names the file and line",
    (await page.locator("#media-results").innerText()).includes(
      "docs/index.html:7 autoplays without muted",
    ),
  );
  await page.mouse.move(0, 0);
  await page.locator("#media-results").scrollIntoViewIfNeeded();
  await screenshot(page, "media-lab");
  fs.rmSync(site, { recursive: true, force: true });
  fs.mkdirSync(site);
  writeSite(site, "good");
  await page.locator("#lab-preview").click();
  await page.locator("#lab-files li", { hasText: "og.png" }).waitFor();
  await page.locator("#lab-consent").check();
  await page.locator("#answer-button").click();
  await page.locator("#media-results", { hasText: "Every fail-level check passed." }).waitFor();
  check("a resubmission is measured again", true);
  await page.locator(".message.from-interviewer", { hasText: "Every check passes" }).waitFor();
  await page.locator("#composer-text").fill("The poster, then it plays muted.");
  await page.locator("#composer button[type=submit]").click();
  const mediaVerdict = await page.locator("#rubric .badge").first().textContent({ timeout: 5000 });
  check("the media lab debrief says Passed", mediaVerdict === "Passed", mediaVerdict);
  fs.rmSync(site, { recursive: true, force: true });

  // A mutation drill: the agent's tests in the workspace, graded against hidden variants.
  const drill = drillArgs();
  writeExercise({
    meta: {
      slug: drill["slug"] as string,
      kind: "mutation",
      lesson: "verify-with-checks",
      title: drill["title"] as string,
      createdAt: Date.now(),
      timesServed: 0,
    },
    teaching: drill["teaching_md"] as string,
    brief: drill["brief_md"] as string,
    private: {
      modelOutline: drill["model_outline"] as string,
      followUps: drill["follow_ups"] as string[],
      pitfalls: drill["pitfalls"] as string[],
      mutation: SPEC,
    },
  });
  updateExerciseMeta("test-the-token-bucket", { validatedAt: Date.now() });
  const drillSession = createLesson({
    lesson: "verify-with-checks",
    lessonTitle: "Give the agent a check it can run",
    module: "test-strength",
    exercise: "test-the-token-bucket",
    exerciseKind: "mutation",
    focus: ["verification"],
    timerMs: 45 * 60_000,
  });
  const workspace = await createWorkspace(drillSession.id, drill["brief_md"] as string, SPEC);
  updateLesson(drillSession.id, (s) => {
    s.drill = { workspace, module: SPEC.module, grades: 0 };
  });
  await page.goto(`${base}/s/${drillSession.id}`);
  check(
    "the drill page shows the workspace",
    (await page.locator("#workspace-path").textContent()) === `cd ${workspace}`,
  );
  await page.locator("#start-button").click();
  await page.locator("#phase", { hasText: "Working" }).waitFor();
  fs.writeFileSync(path.join(workspace, "tests", "test_bucket.py"), WEAK_TESTS);
  await page.locator("#grade-button").click();
  await page.locator("#grade-result", { hasText: "2 of 5" }).waitFor({ timeout: 30_000 });
  check(
    "a grade shows counts but not which bugs survived",
    !(await page.locator("#grade-result").innerText()).includes("capacity"),
  );
  await page.locator(".message.from-interviewer", { hasText: "exactly" }).waitFor();
  check("the interviewer asks about the weak grade", true);
  await page.mouse.move(0, 0);
  await screenshot(page, "drill");
  fs.writeFileSync(path.join(workspace, "tests", "test_bucket.py"), ORACLE);
  await page.locator("#grade-button").click();
  await page.locator("#grade-result", { hasText: "Past the gate" }).waitFor({ timeout: 30_000 });
  const drillVerdict = await page
    .locator("#rubric .badge")
    .first()
    .textContent({ timeout: 10_000 });
  check("the drill passes on the stronger suite", drillVerdict === "Passed", drillVerdict);
  check(
    "the debrief reports the planted bugs",
    (await page.locator("#rubric", { hasText: "Your tests caught every one." }).count()) === 1,
  );
  check(
    "no stray text in the debrief",
    !(await page.locator("#rubric").innerText()).includes("null"),
  );
  await screenshot(page, "drill-debrief");

  // A flaw review: mark lines of the diff, then submit.
  const flaws = flawArgs();
  writeExercise({
    meta: {
      slug: flaws["slug"] as string,
      kind: "flaw-review",
      lesson: "review-agent-diffs",
      title: flaws["title"] as string,
      createdAt: Date.now(),
      timesServed: 0,
    },
    teaching: flaws["teaching_md"] as string,
    brief: flaws["brief_md"] as string,
    private: {
      modelOutline: flaws["model_outline"] as string,
      followUps: flaws["follow_ups"] as string[],
      pitfalls: flaws["pitfalls"] as string[],
      flawReview: FLAW_SPEC,
    },
  });
  updateExerciseMeta("review-the-invoices-diff", { validatedAt: Date.now() });
  const reviewSession = createLesson({
    lesson: "review-agent-diffs",
    lessonTitle: "Catch what the agent got wrong",
    module: "review-accuracy-security",
    exercise: "review-the-invoices-diff",
    exerciseKind: "flaw-review",
    focus: ["safety", "verification"],
    timerMs: 45 * 60_000,
  });
  await page.goto(`${base}/s/${reviewSession.id}`);
  check("the flaw review shows the diff", (await page.locator(".diff tr[data-line]").count()) > 30);
  await page.locator("#start-button").click();
  await page.locator("#phase", { hasText: "Working" }).waitFor();
  for (const [line, category] of [
    [6, "secret"],
    [25, "injection"],
    [19, "missing-authz"],
    [32, "hallucinated-api"],
  ] as const) {
    await page.locator(`.diff tr[data-line="${line}"]`).click();
    await page.locator("#mark-category").selectOption(category);
    await page.locator("#mark-reason").fill(`line ${line} is wrong`);
    await page.locator("#mark-form button[type=submit]").click();
  }
  check("marks are listed and shown on the diff", (await page.locator("#marks li").count()) === 4);
  check("marked lines are highlighted", (await page.locator(".diff tr.marked").count()) === 4);
  await page.mouse.move(0, 0);
  await screenshot(page, "flaw-review");
  await page.locator("#review-button").click();
  await page.locator("#review-result", { hasText: "4 of 5" }).waitFor({ timeout: 10_000 });
  const reviewVerdict = await page
    .locator("#rubric .badge")
    .first()
    .textContent({ timeout: 10_000 });
  check(
    "the review passes on the criticals and most flaws",
    reviewVerdict === "Passed",
    reviewVerdict,
  );
  check(
    "the debrief lists every planted flaw, the missed one marked",
    (await page.locator("#rubric .checklist-results li").count()) === 5 &&
      (await page.locator("#rubric .badge", { hasText: "missed" }).count()) === 1,
  );
  await screenshot(page, "flaw-review-debrief");

  // A cache plan: paste the agent's plan, check it, and see the best plan in the debrief.
  const cache = cacheArgs();
  writeExercise({
    meta: {
      slug: cache["slug"] as string,
      kind: "cache-plan",
      lesson: "prompt-caching",
      title: cache["title"] as string,
      createdAt: Date.now(),
      timesServed: 0,
    },
    teaching: cache["teaching_md"] as string,
    brief: cache["brief_md"] as string,
    private: {
      modelOutline: cache["model_outline"] as string,
      followUps: cache["follow_ups"] as string[],
      pitfalls: cache["pitfalls"] as string[],
      cachePlan: { scenario: SCENARIO, reference: REFERENCE },
    },
  });
  updateExerciseMeta("cache-the-support-bot", { validatedAt: Date.now() });
  const planSession = createLesson({
    lesson: "prompt-caching",
    lessonTitle: "How prompt caching prices a session",
    module: "cost-context",
    exercise: "cache-the-support-bot",
    exerciseKind: "cache-plan",
    focus: ["contextCost"],
    timerMs: 45 * 60_000,
  });
  await page.goto(`${base}/s/${planSession.id}`);
  check(
    "the cache plan shows the workload",
    (await page.locator(".segments tbody tr").count()) === 4,
  );
  await page.locator("#start-button").click();
  await page.locator("#phase", { hasText: "Working" }).waitFor();
  await page.locator("#answer-text").fill(JSON.stringify(REFERENCE, null, 2));
  await page.locator("#plan-button").click();
  await page.locator("#plan-result", { hasText: "Past the gate" }).waitFor({ timeout: 10_000 });
  await page.mouse.move(0, 0);
  await screenshot(page, "cache-plan");
  const planVerdict = await page.locator("#rubric .badge").first().textContent({ timeout: 10_000 });
  check("the plan passes at the reference's cost", planVerdict === "Passed", planVerdict);
  check(
    "the debrief shows the best plan known",
    (await page.locator("#rubric", { hasText: "The best plan known" }).count()) === 1,
  );

  // A phone screen: questions on the page, typed answers with delivery, a debrief.
  const call = createPhoneSession({ format: "recruiter", company: "Stripe", timerMs: 20 * 60_000 });
  recordBriefs([
    {
      company: "Stripe",
      format: "recruiter",
      minutes: 30,
      seenAt: "2026-08-01",
      sourceUrl: "https://example.com/stripe-recruiter",
      note: "Background, why Stripe, a project walkthrough, and timeline.",
    },
  ]);
  await page.goto(`${base}/s/${call.id}`);
  check(
    "the phone page shows the company's screens",
    (await page.locator(".phone-brief li").count()) === 1,
  );
  await page.locator("#voice-toggle").uncheck();
  await page.locator("#start-button").click();
  await page.locator("#question-text", { hasText: "Tell me about yourself." }).waitFor();
  check("the first question appears on the call", true);
  await page
    .locator("#answer-text")
    .fill("I'm a senior at Virginia Tech. I built a mock-interview tool, um, used by my club.");
  await page.locator("#send-button").click();
  await page.locator(".line-reply .delivery", { hasText: "typed" }).waitFor();
  await page.locator(".line-interviewer", { hasText: "why this company" }).waitFor();
  check("a follow-up arrives after the answer", true);
  await page.locator("#answer-text").fill("Stripe's API docs taught me how to design my own.");
  await page.locator("#send-button").click();
  await page.locator(".line-reply >> nth=1").waitFor();
  await page.mouse.move(0, 0);
  await screenshot(page, "phone");
  await page.locator("#done-button").click();
  await page.locator("#rubric h2", { hasText: "Debrief" }).waitFor({ timeout: 10_000 });
  check(
    "the phone debrief scores each answer",
    (await page.locator("#rubric .answer-scores li").count()) === 1,
  );
  check("the call passed", readPhoneSession(call.id).verdict?.correct === true);

  // Server state.
  check("the verdict is recorded", readSession(session.id).verdict?.correct === true);
  check(
    "review events were appended",
    readReviewEvents()
      .map((e) => e.key)
      .sort()
      .join() ===
      "lesson:context-files,lesson:pages-site,lesson:plan-before-code,lesson:prompt-caching,lesson:review-agent-diffs,lesson:verify-with-checks,pattern:sliding-window,phone:recruiter,problem:window-sum",
  );
  check("no browser errors", errors.length === 0, errors.join("; "));

  console.log(`e2e: ${passed.length} checks passed\n- ${passed.join("\n- ")}`);
} finally {
  await browser.close();
  await server.close();
  setHooks({});
  fixture.cleanup();
}
