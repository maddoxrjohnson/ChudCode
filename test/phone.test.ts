import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deliveryLine,
  deliverySummary,
  fundamentalsTopics,
  measureDelivery,
  phoneVerdict,
  topicIds,
} from "../src/phone.ts";
import { parseKey } from "../src/review.ts";
import {
  briefProblems,
  briefsFor,
  createPhoneSession,
  eventsFromPhone,
  phoneReviewEvents,
  readStories,
  recordBriefs,
  saveStory,
  type PhoneBriefInput,
  type PhoneSession,
} from "../src/store/phone.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fixture: Fixture;
beforeEach(() => {
  fixture = makeFixture();
});
afterEach(() => fixture.cleanup());

describe("measureDelivery", () => {
  it("counts words, pace, and only unambiguous fillers", () => {
    const text =
      "Um so I led the migration, uh, you know, basically kind of end to end. You know what I mean? Like I said.";
    const d = measureDelivery(text, { spoken: true, durationMs: 12_000, longPauses: 2 });
    expect(d).toMatchObject({ spoken: true, durationMs: 12_000, words: 23, longPauses: 2 });
    expect(d.wpm).toBe(115);
    // "you know what" and "like" are not counted; "so" never is.
    expect(d.fillerWords).toEqual(["basically ×1", "kind of ×1", "uh ×1", "um ×1", "you know ×1"]);
    expect(d.fillers).toBe(5);
    expect(deliveryLine(d)).toBe(
      "spoken for 12 s, 23 words, 115 wpm, fillers: basically ×1, kind of ×1, uh ×1, um ×1, you know ×1, 2 pauses over 3 s",
    );
  });

  it("treats the page's numbers as untrusted and gives typed replies no pace", () => {
    expect(
      measureDelivery("hi there", { spoken: "yes", durationMs: -5, longPauses: 1e9 }),
    ).toMatchObject({
      spoken: false,
      durationMs: 0,
      wpm: null,
      longPauses: 0,
    });
    expect(measureDelivery("short", { spoken: true, durationMs: 3_000 }).wpm).toBeNull();
    expect(measureDelivery("x", { spoken: true, durationMs: 1e12, longPauses: 9e9 })).toMatchObject(
      {
        durationMs: 20 * 60_000,
        longPauses: 200,
      },
    );
    expect(deliveryLine(measureDelivery("I typed this", {}))).toBe("typed, 3 words");
  });
});

function session(overrides: Partial<PhoneSession> = {}): PhoneSession {
  return {
    id: "20261025-1000-phone-fundamentals-abcd",
    kind: "phone",
    format: "fundamentals",
    timerMs: 20 * 60_000,
    createdAt: 1,
    startedAt: 1,
    endedAt: 600_001,
    phase: "done",
    questions: [
      {
        n: 1,
        text: "TCP vs UDP?",
        topic: "networking",
        askedAt: 2,
        replies: [
          {
            at: 3,
            text: "a",
            delivery: measureDelivery("a b c d e f", { spoken: true, durationMs: 6_000 }),
          },
        ],
      },
      {
        n: 2,
        text: "What is a deadlock?",
        topic: "concurrency",
        askedAt: 4,
        replies: [
          {
            at: 5,
            text: "b",
            delivery: measureDelivery("um yes", { spoken: true, durationMs: 6_000, longPauses: 1 }),
          },
        ],
      },
      { n: 3, text: "And a livelock?", topic: "concurrency", askedAt: 6, replies: [] },
    ],
    ...overrides,
  };
}

describe("verdict and review events", () => {
  it("passes when a question was answered and every dimension is 2 or more", () => {
    expect(phoneVerdict(session(), { accuracy: 2, depth: 3, clarity: 2 })).toEqual({
      correct: true,
      rubricOk: true,
      answered: true,
    });
    expect(phoneVerdict(session(), { accuracy: 1, depth: 3, clarity: 2 }).correct).toBe(false);
    expect(
      phoneVerdict(session({ questions: [] }), { accuracy: 4, depth: 4, clarity: 4 }),
    ).toMatchObject({ correct: false, answered: false });
  });

  it("schedules the format and each answered fundamentals topic by its best score", () => {
    const s = session({
      verdict: { correct: true, rubricOk: true, answered: true },
      rubric: {
        scores: { accuracy: 2, depth: 2, clarity: 2 },
        answers: [
          { n: 1, score: 3, note: "" },
          { n: 2, score: 1, note: "" },
        ],
        notesMd: "",
        strengths: [],
        improvements: [],
      },
    });
    const events = phoneReviewEvents(s, true, 10);
    expect(events.map((e) => [e.key, e.correct])).toEqual([
      ["phone:fundamentals", true],
      ["phone:topic-networking", true],
      ["phone:topic-concurrency", false],
    ]);
    expect(events[0]?.timeMs).toBe(600_000);
    expect(parseKey("phone:topic-networking")).toEqual({ kind: "phone", id: "topic-networking" });
    // Abandoned for a reason that counts: every topic a miss; interrupted: nothing.
    expect(
      eventsFromPhone([{ ...session(), abandonedReason: "left" }]).every((e) => !e.correct),
    ).toBe(true);
    expect(eventsFromPhone([{ ...session(), abandonedReason: "interrupted" }])).toEqual([]);
  });

  it("sums delivery over spoken replies", () => {
    expect(deliverySummary(session())).toMatchObject({
      spokenReplies: 2,
      typedReplies: 0,
      averageWpm: 40,
      longPauses: 1,
      longestMs: 6_000,
    });
  });
});

describe("the story bank", () => {
  const story = {
    title: "The flaky deploy",
    situation: "s",
    task: "t",
    action: "a",
    result: "r",
    tags: ["Failure", "ownership", ""],
  };

  it("saves, updates by id, and records the calls a story was told in", () => {
    const first = saveStory({ ...story, session: "20261025-1000-phone-behavioral-abcd" }, 1);
    expect(first.id).toMatch(/^s-[0-9a-f]{8}$/);
    expect(first.tags).toEqual(["failure", "ownership"]);
    const second = saveStory(
      {
        ...story,
        id: first.id,
        result: "Cut deploy failures from 1 in 5 to none",
        session: "20261026-1000-phone-behavioral-beef",
      },
      2,
    );
    expect(readStories()).toHaveLength(1);
    expect(second).toMatchObject({
      result: "Cut deploy failures from 1 in 5 to none",
      sessions: ["20261025-1000-phone-behavioral-abcd", "20261026-1000-phone-behavioral-beef"],
    });
    expect(() => saveStory({ ...story, id: "s-00000000" })).toThrow(/No story/);
  });
});

describe("company phone briefs", () => {
  const brief: PhoneBriefInput = {
    company: "Stripe",
    format: "recruiter",
    minutes: 30,
    seenAt: "2026-08-01",
    sourceUrl: "https://example.com/post/1",
    note: "Recruiter asked about past projects, why payments, and visa status.",
  };

  it("validates every field", () => {
    expect(briefProblems(brief, topicIds(), "2026-10-25")).toEqual([]);
    const bad = briefProblems(
      {
        ...brief,
        format: "lunch" as never,
        minutes: 2,
        seenAt: "2027-01-01",
        sourceUrl: "nope",
        note: "see https://x.y",
        topics: ["vibes"],
      },
      topicIds(),
      "2026-10-25",
    );
    expect(bad).toEqual([
      "format must be one of recruiter, behavioral, fundamentals, technical",
      "minutes must be a whole number from 5 to 180",
      "seenAt must be a past date, YYYY-MM-DD",
      "sourceUrl must be the post's http(s) URL",
      "note may not hold a link; the URL goes in sourceUrl",
      "topics: vibes is not a fundamentals topic",
    ]);
  });

  it("stores each post once and finds a company ignoring case", () => {
    expect(recordBriefs([brief, { ...brief, format: "behavioral" }], 1)).toEqual({
      added: 2,
      skipped: 0,
    });
    expect(recordBriefs([brief], 2)).toEqual({ added: 0, skipped: 1 });
    expect(
      briefsFor("stripe")
        .map((b) => b.format)
        .sort(),
    ).toEqual(["behavioral", "recruiter"]);
  });
});

describe("sessions", () => {
  it("creates a phone session with an id like any other", () => {
    const s = createPhoneSession(
      { format: "recruiter", company: "Stripe", timerMs: 60_000 },
      Date.UTC(2026, 9, 25, 10),
    );
    expect(s.id).toMatch(/^\d{8}-\d{4}-phone-recruiter-stripe-[0-9a-f]{4}$/);
    expect(s).toMatchObject({ kind: "phone", phase: "briefing", questions: [] });
  });

  it("ships a fundamentals topic list with unique ids", () => {
    const ids = fundamentalsTopics().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("networking");
  });
});
