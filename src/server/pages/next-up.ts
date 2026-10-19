/**
 * next-up.ts: the Next problem button, on the dashboard and under a roadmap debrief.
 *
 * The row names the next step and has three states: ready (an interviewer is around
 * to answer a press), waiting (pressed, and the page opens the new session once the
 * interviewer starts it), and away (nobody to answer, so it says what to type in the
 * terminal). The runtime module flips between them from the same data attributes.
 */

import { escapeHtml } from "../../markdown.ts";
import type { NextUp } from "../../next-up.ts";
import { LESSONS_KEY, type NextLesson } from "../../next-lesson.ts";
import type { NextRequest } from "../hooks.ts";
import { difficultyBadge } from "./layout.ts";

export interface NextButtonView {
  /** Whether an interviewer is around to answer a press. */
  connected: boolean;
  pending: NextRequest | null;
  /** The roadmap command for this host, e.g. `/chudcode:roadmap`. */
  command: string;
}

export type NextState = "ready" | "waiting" | "away";

export function nextState(next: NextUp, view: NextButtonView): NextState {
  if (view.pending?.roadmap === next.roadmap) return "waiting";
  return view.connected ? "ready" : "away";
}

/** What to type in the terminal for this roadmap when nobody answers the button. */
export function nextCommand(next: NextUp, view: NextButtonView): string {
  return next.roadmap === "grind75" ? `${view.command} grind75` : view.command;
}

/** Mirrored in assets/runtime/shared/next-up.mjs. */
export function nextStatusText(next: NextUp, state: NextState, command: string): string {
  if (state === "waiting") return "Waiting for the interviewer to open it…";
  if (state === "away")
    return `The interviewer is away. Type ${command} in your terminal to carry on.`;
  return next.prepared
    ? "Written and validated: it opens at once."
    : "The interviewer writes it when you press, in about a minute.";
}

export function nextUpHtml(next: NextUp, view: NextButtonView): string {
  const state = nextState(next, view);
  const command = nextCommand(next, view);
  return `<div class="next-up" data-roadmap="${escapeHtml(next.roadmap)}" data-state="${state}" data-prepared="${next.prepared ? "1" : "0"}" data-command="${escapeHtml(command)}">
  <span class="next-what"><span class="muted">Next on ${escapeHtml(next.name)}:</span> <strong>${escapeHtml(next.title)}</strong> ${difficultyBadge(next.difficulty)} <span class="muted small">${escapeHtml(next.stage)}</span></span>
  <button type="button" class="button primary next-button"${state === "ready" ? "" : " disabled"}>Next problem</button>
  <span class="next-status muted small" aria-live="polite">${escapeHtml(nextStatusText(next, state, command))}</span>
</div>`;
}

/**
 * The Next lesson row: the same three states and the same runtime as Next problem,
 * keyed as the "lessons" roadmap and posting to /api/curriculum/next.
 */
export function nextLessonHtml(
  next: NextLesson,
  view: { connected: boolean; pending: boolean; command: string },
): string {
  const state: NextState = view.pending ? "waiting" : view.connected ? "ready" : "away";
  const status =
    state === "waiting"
      ? "Waiting for the interviewer to open it…"
      : state === "away"
        ? `The interviewer is away. Type ${view.command} in your terminal to carry on.`
        : next.prepared
          ? "Written and validated: it opens at once."
          : "The interviewer writes it when you press, in about a minute.";
  return `<div class="next-up next-lesson" id="agentic-next" data-roadmap="${LESSONS_KEY}" data-url="/api/curriculum/next" data-state="${state}" data-prepared="${next.prepared ? "1" : "0"}" data-command="${escapeHtml(view.command)}">
  <span class="next-what">Next lesson: <strong>${escapeHtml(next.title)}</strong> <span class="muted small">in ${escapeHtml(next.moduleName)}</span></span>
  <button type="button" class="button primary next-button"${state === "ready" ? "" : " disabled"}>Next lesson</button>
  <span class="next-status muted small" aria-live="polite">${escapeHtml(status)}</span>
</div>`;
}
