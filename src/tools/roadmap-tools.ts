/**
 * roadmap-tools.ts: where the candidate stands on NeetCode 150 or Grind 75.
 */

import { roadmapListText } from "../prompts.ts";
import { loadRoadmapProgress, ROADMAP_IDS } from "../roadmap.ts";
import { fail, ok, optionalEnum, optionalString, schema, type ToolDef } from "./index.ts";

export function roadmapTools(): ToolDef[] {
  return [
    {
      name: "list_roadmap",
      title: "List Roadmap",
      description:
        "Progress through a public problem list worked in order: every topic (NeetCode 150) or week (Grind 75) with its solved count and whether it is open, and the next problem. " +
        "Pass stage to list one topic's problems. Call it when the user asks how far along a roadmap they are.",
      inputSchema: schema.obj(
        {
          roadmap: schema.oneOf(ROADMAP_IDS, "Which list. Default neetcode150."),
          stage: schema.str("A stage id from the list, e.g. two-pointers or week-3."),
        },
        ["roadmap", "stage"],
      ),
      async execute(args) {
        const progress = loadRoadmapProgress(
          optionalEnum(args, "roadmap", ROADMAP_IDS) ?? "neetcode150",
        );
        const stage = optionalString(args, "stage", 64);
        if (stage !== undefined && !progress.stages.some((s) => s.id === stage)) {
          return fail(
            `No stage ${stage} on ${progress.name}. Stages: ${progress.stages.map((s) => s.id).join(", ")}.`,
          );
        }
        return ok(roadmapListText(progress, stage), {
          roadmap: progress.id,
          solved: progress.solved,
          total: progress.total,
          next: progress.next
            ? { stage: progress.next.stage.id, title: progress.next.item.title }
            : null,
          stages: progress.stages.map((s) => ({
            id: s.id,
            name: s.name,
            unlocked: s.unlocked,
            solved: s.solved,
            total: s.total,
          })),
        });
      },
    },
  ];
}
