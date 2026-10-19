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
 * interviewer to the session it opens, and an agentic-coding lesson from its sourced
 * teaching to the debrief.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { chromium, type Page } from "playwright";

import { notifyDashboard, postMessage, recordSession, startSession } from "../src/flow.ts";
import { resolveNext } from "../src/next-up.ts";
import { setHooks, type CandidateEvent, type NextRequest } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { updateMeta } from "../src/store/problems.ts";
import { readReviewEvents } from "../src/store/review-events.ts";
import { createSession, readDraft, readSession } from "../src/store/sessions.ts";
import { postLessonMessage, recordLesson } from "../src/lesson-flow.ts";
import { updateExerciseMeta, writeExercise } from "../src/store/exercises.ts";
import { createLesson, lessonExists } from "../src/store/lessons.ts";
import { makeFixture, seedExample } from "../test/helpers.ts";
import { exerciseArgs } from "../test/lesson-fixtures.ts";

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
    "unscored dimensions show as n/a",
    (await page.locator("#rubric .scores li", { hasText: "n/a" }).count()) === 2,
  );
  await screenshot(page, "lesson-debrief");
  await page.goto(base);
  const lessonsBadge = await page.locator("#agentic .badge").first().textContent();
  check(
    "the dashboard counts the passed lesson",
    lessonsBadge === "1/9 lessons passed",
    lessonsBadge,
  );

  // Server state.
  check("the verdict is recorded", readSession(session.id).verdict?.correct === true);
  check(
    "review events were appended",
    readReviewEvents()
      .map((e) => e.key)
      .sort()
      .join() === "lesson:plan-before-code,pattern:sliding-window,problem:window-sum",
  );
  check("no browser errors", errors.length === 0, errors.join("; "));

  console.log(`e2e: ${passed.length} checks passed\n- ${passed.join("\n- ")}`);
} finally {
  await browser.close();
  await server.close();
  setHooks({});
  fixture.cleanup();
}
