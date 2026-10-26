/**
 * routes-pages.ts: HTML pages and static assets.
 */

import { phoneState } from "../phone-flow.ts";
import { listPhoneSessions, phoneExists, readStories } from "../store/phone.ts";
import { fundamentalsTopics } from "../phone.ts";
import { phonePage } from "./pages/phone.ts";
import type * as http from "node:http";

import { sessionState } from "../flow.ts";
import { nextUp, pendingNext, sessionRoadmap } from "../next-up.ts";
import { currentDelivery } from "../prompts.ts";
import { loadProgress } from "../progress.ts";
import { loadRoadmapProgress, ROADMAP_IDS } from "../roadmap.ts";
import { readConfig } from "../store/config.ts";
import { assetsDir, isValidSessionId, isValidSlug, safeJoin } from "../store/paths.ts";
import { listProblems, problemExists, publicView, readProblem } from "../store/problems.ts";
import { listSessions, readSession, sessionExists } from "../store/sessions.ts";
import { agentConnected, agentListening } from "./hooks.ts";
import { HttpError, sendFile, sendHtml } from "./http.ts";
import { dashboardPage, type AgenticData, type PhoneData } from "./pages/dashboard.ts";
import { reviewItems } from "../store/review-events.ts";
import { nextUpHtml, type NextButtonView } from "./pages/next-up.ts";
import { problemPage } from "./pages/problem.ts";
import { sessionPage } from "./pages/session.ts";
import { lessonPage } from "./pages/lesson.ts";
import { nextLessonHtml } from "./pages/next-up.ts";
import { nextLesson, pendingNextLesson } from "../next-lesson.ts";
import { findLesson, loadCurriculumProgress } from "../curriculum.ts";
import { drillReveal, drillSurvivors, latestMediaSnapshot, lessonState } from "../lesson-flow.ts";
import { factFreshness, readFactChecks } from "../store/fact-checks.ts";
import { lessonExists, listLessons, readAnswer, readLesson } from "../store/lessons.ts";

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1f6feb"/><path d="M11 10l-5 6 5 6M21 10l5 6-5 6M18 8l-4 16" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function handlePage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
): void {
  if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");

  if (segments.length === 0) {
    return sendHtml(
      res,
      dashboardPage({
        sessions: listSessions(20),
        problems: listProblems(),
        progress: loadProgress(),
        roadmaps: ROADMAP_IDS.map(loadRoadmapProgress),
        next: { ups: ROADMAP_IDS.flatMap((id) => nextUp(id) ?? []), view: nextButtonView() },
        agentic: agenticData(),
        phone: phoneData(),
      }),
    );
  }

  const [head, ...rest] = segments;
  if (head === "favicon.ico") {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" });
    return void res.end(FAVICON);
  }

  if (head === "static") {
    const file = safeJoin(assetsDir(), rest.join("/"));
    if (!file || rest.length === 0) throw new HttpError(404, "No such asset");
    return sendFile(res, file);
  }

  if (head === "s" && rest.length === 1 && phoneExists(rest[0] ?? "")) {
    return sendHtml(res, phonePage(phoneState(rest[0] as string, agentListening())));
  }

  if (head === "s" && rest.length === 1 && lessonExists(rest[0] ?? "")) {
    return sendHtml(res, lessonPageFor(rest[0] as string));
  }

  if (head === "s" && rest.length === 1) {
    const [id] = rest;
    if (!isValidSessionId(id) || !sessionExists(id)) throw new HttpError(404, "No such session");
    const config = readConfig();
    const roadmap = sessionRoadmap(readSession(id));
    return sendHtml(
      res,
      sessionPage(sessionState(id, agentListening()), {
        autocomplete: config.editor.autocomplete,
        connected: agentConnected(),
        ...(roadmap ? { roadmap, nextHtml: sessionNextHtml(id) } : {}),
      }),
    );
  }

  if (head === "p" && rest.length === 1) {
    const [slug] = rest;
    if (!isValidSlug(slug) || !problemExists(slug)) throw new HttpError(404, "No such problem");
    return sendHtml(res, problemPage(publicView(readProblem(slug), 0)));
  }

  throw new HttpError(404, "No such page");
}

export function phoneData(): PhoneData {
  return {
    sessions: listPhoneSessions(20),
    items: reviewItems().filter((i) => i.kind === "phone"),
    stories: readStories(),
    topics: fundamentalsTopics().map((t) => ({ id: t.id, name: t.name })),
  };
}

export function agenticData(now = Date.now()): AgenticData {
  const row = lessonNextHtml();
  return {
    progress: loadCurriculumProgress(),
    lessons: listLessons(10),
    due: reviewItems().filter((i) => i.kind === "lesson" && i.dueAt <= now),
    ...(row ? { nextRow: row } : {}),
  };
}

/** The Next lesson row, or "" when every teachable lesson is passed. */
export function lessonNextHtml(): string {
  const next = nextLesson();
  if (!next) return "";
  return nextLessonHtml(next, {
    connected: agentConnected(),
    pending: pendingNextLesson() !== null,
    command: currentDelivery() === "push" ? "/learn" : "/chudcode:learn",
  });
}

function lessonPageFor(id: string): string {
  const session = readLesson(id);
  const place = findLesson(session.lesson);
  const answers: string[] = [];
  for (let n = 1; n <= session.answers; n += 1) answers.push(readAnswer(id, n) ?? "");
  return lessonPage(lessonState(id, agentListening()), {
    moduleName: place?.module.name ?? session.module,
    facts: factFreshness(place?.lesson.facts ?? [], readFactChecks(), Date.now()),
    answers,
    ...(session.exerciseKind === "lab"
      ? { checklist: place?.lesson.checklist ?? [], labFiles: place?.lesson.labFiles ?? [] }
      : session.exerciseKind === "transcript"
        ? { checklist: place?.lesson.checklist ?? [] }
        : session.exerciseKind === "media-lab"
          ? {
              checklist: place?.lesson.checklist ?? [],
              mediaChecks: latestMediaSnapshot(session)?.checks ?? null,
            }
          : {}),
    ...((session.exerciseKind === "mutation" || session.exerciseKind === "refactor") &&
    session.rubric
      ? { survivors: drillSurvivors(session) }
      : {}),
    ...(session.rubric ? { reveal: drillReveal(session), nextHtml: lessonNextHtml() } : {}),
  });
}

/** Whether a press of Next problem will be answered, and what to type if not. */
export function nextButtonView(): NextButtonView {
  return {
    connected: agentConnected(),
    pending: pendingNext(),
    command: currentDelivery() === "push" ? "/roadmap" : "/chudcode:roadmap",
  };
}

/** The button row under a scored roadmap session's debrief, or "" before then. */
export function sessionNextHtml(id: string): string {
  const session = readSession(id);
  const roadmap = sessionRoadmap(session);
  if (session.phase !== "done" || !session.rubric || !roadmap) return "";
  const up = nextUp(roadmap);
  return up ? nextUpHtml(up, nextButtonView()) : "";
}
