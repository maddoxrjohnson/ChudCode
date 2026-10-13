/**
 * Browser end-to-end check: drive the real interview page in headless Chromium
 * against the real server, with a scripted interviewer standing in for the agent.
 *
 *   npm run e2e:browser [-- <screenshot directory>]
 *
 * Run `npx playwright install chromium` once first. State lives in a throwaway
 * directory. This covers what the unit tests cannot: the editor, autosave, the Run
 * and Submit buttons, custom input, the hint ladder, the chat in both directions,
 * the debrief card arriving over SSE, and the dashboard reflecting the scored
 * session and reloading when another one starts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { chromium, type Page } from "playwright";

import { postMessage, recordSession, startSession } from "../src/flow.ts";
import { setHooks, type CandidateEvent } from "../src/server/hooks.ts";
import * as server from "../src/server/server.ts";
import { readReviewEvents } from "../src/store/review-events.ts";
import { createSession, readDraft, readSession } from "../src/store/sessions.ts";
import { makeFixture, seedExample } from "../test/helpers.ts";

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

// ── The run ───────────────────────────────────────────────────────────────────

const fixture = makeFixture();
seedExample();
setHooks({
  isListening: () => true,
  // Reply after the request that raised the event has been answered, as an agent would.
  onCandidateEvent: (event) => void setTimeout(() => interviewer(event), 50),
});

const session = createSession({
  problem: "window-sum",
  problemTitle: "Largest Window Sum",
  patterns: ["sliding-window"],
  difficulty: "easy",
  mode: "interview",
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

  // Server state.
  check("the verdict is recorded", readSession(session.id).verdict?.correct === true);
  check(
    "review events were appended",
    readReviewEvents()
      .map((e) => e.key)
      .sort()
      .join() === "pattern:sliding-window,problem:window-sum",
  );
  check("no browser errors", errors.length === 0, errors.join("; "));

  console.log(`e2e: ${passed.length} checks passed\n- ${passed.join("\n- ")}`);
} finally {
  await browser.close();
  await server.close();
  setHooks({});
  fixture.cleanup();
}
