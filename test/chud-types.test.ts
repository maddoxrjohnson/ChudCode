/**
 * chud_types.py: the JSON forms of linked lists and trees, run under the real interpreter.
 */

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { pythonAdapter, pythonAvailable } from "../src/runner/adapters/python/adapter.ts";
import { pythonAdapterDir } from "../src/store/paths.ts";

const SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from chud_types import ListNode, TreeNode, from_json, to_json

out = {}
tree = from_json([1, None, 2, 3], "Optional[TreeNode]")
out["tree_gap"] = [tree.val, tree.left, tree.right.val, tree.right.left.val]
out["tree_round_trip"] = to_json(tree)
out["tree_trailing_nones"] = to_json(from_json([1, 2, 3, None, None], "TreeNode"))
out["tree_empty"] = to_json(from_json([], "TreeNode"), "TreeNode")
out["tree_empty_untyped"] = to_json(from_json([], "TreeNode"))
out["tree_none"] = to_json(None, "Optional[TreeNode]")
out["list_round_trip"] = to_json(from_json([1, 2, 3], "ListNode"))
out["list_of_lists"] = to_json(from_json([[1, 2], [], [3]], "List[Optional[ListNode]]"), "List[Optional[ListNode]]")
out["list_of_lists_untyped"] = to_json(from_json([[1, 2], [], [3]], "List[Optional[ListNode]]"))
out["list_none"] = to_json(None, "Optional[ListNode]")
out["plain_none"] = to_json(None, "int")
out["set"] = to_json({3, 1, 2})
out["tuple"] = to_json((1, (2, 3)))
out["dict"] = to_json({1: "a", "b": (2,)})
out["bool"] = to_json(True)
out["object"] = to_json(object()).startswith("<object object")
cyclic = ListNode(1)
cyclic.next = cyclic
try:
    to_json(cyclic)
    out["cycle"] = "no error"
except ValueError as err:
    out["cycle"] = str(err)
print(json.dumps(out))
`;

describe.skipIf(!pythonAvailable())("chud_types", () => {
  it("converts between LeetCode array forms and node objects", () => {
    const run = spawnSync(pythonAdapter.pythonBin, ["-I", "-c", SCRIPT, pythonAdapterDir()], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(out).toEqual({
      tree_gap: [1, null, 2, 3],
      tree_round_trip: [1, null, 2, 3],
      tree_trailing_nones: [1, 2, 3],
      tree_empty: [],
      tree_empty_untyped: null,
      tree_none: [],
      list_round_trip: [1, 2, 3],
      list_of_lists: [[1, 2], [], [3]],
      list_of_lists_untyped: [[1, 2], null, [3]],
      list_none: [],
      plain_none: null,
      set: [1, 2, 3],
      tuple: [1, [2, 3]],
      dict: { "1": "a", b: [2] },
      bool: true,
      object: true,
      cycle: "linked list output has a cycle",
    });
  });
});
