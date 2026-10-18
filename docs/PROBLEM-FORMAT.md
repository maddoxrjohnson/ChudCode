# Problem format

A problem is a directory of plain files under `~/.chudcode/problems/<slug>/`. The
interviewer writes one with `write_problem`, proves it with `validate_problem`, and
serves it with `start_session`. Hand-written bundles live in `problems/examples/` in
the repository and are copied in on first use. Either way the files are the same.

```
<slug>/
  meta.json        title, patterns, difficulty, signature, complexity target, source, validation state
  statement.md     what the candidate reads
  tests.json       visible and hidden cases
  reference.py     the author's optimal solution; the oracle for generated cases
  hints.json       the hint ladder
  generators.py    optional: functions that build large inputs
  checker.py       optional: check(input, actual, expected) for problems with several right answers
```

The candidate's browser only ever receives the public view: the statement, the
signature, the visible cases, the hints revealed so far, and the number of hidden
cases. The reference, hidden inputs, unrevealed hints, generators, checker, and
complexity target never leave the server.

## meta.json

```json
{
  "slug": "warmest-week",
  "title": "Warmest Week",
  "patterns": ["sliding-window"],
  "difficulty": "easy",
  "language": "python",
  "signature": {
    "style": "function",
    "name": "warmest_week",
    "params": [
      { "name": "temps", "type": "List[int]" },
      { "name": "k", "type": "int" }
    ],
    "returns": "int"
  },
  "complexityTarget": { "time": "O(n)", "space": "O(1)" },
  "source": { "kind": "generated" },
  "createdAt": 1759881600000,
  "validatedAt": 1759881900000,
  "validation": { "passed": 12, "total": 12 },
  "timesServed": 0
}
```

| Field                | Meaning                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`               | Lowercase kebab-case, at most 64 characters. The directory name and the key sessions use.                                                                                                                                                            |
| `patterns`           | Ids from `data/patterns.json`. The first is the pattern the problem drills; it decides what spaced review schedules. Unknown ids are rejected.                                                                                                       |
| `difficulty`         | `easy`, `medium`, or `hard`. Guide: easy is one pattern applied directly (15 minutes); medium adds a twist or a second pattern (25–35 minutes); hard needs a non-obvious reduction or a tight bound.                                                 |
| `signature`          | `style` is `function` for a top-level `def` or `method` for a method on `class Solution`. Types use Python notation: `int`, `str`, `List[int]`, `List[List[str]]`, `Optional[ListNode]`, `Optional[TreeNode]`. The editor stub is generated from it. |
| `complexityTarget`   | The bounds the reference meets, written as `O(...)`. The interviewer compares the candidate's solution against them when deciding `complexity_ok`.                                                                                                   |
| `source.kind`        | `generated` (invented for a pattern), `mimic` (follows the shape of a real problem; `mimicOf` holds its title), `review` (a spaced-review variant), `hand` (written in the repository).                                                              |
| `source.trendIds`    | Ids of the trend entries whose shape the problem follows, when a company's recent interviews shaped it (see `TRENDS-FORMAT.md`). `write_problem` rejects an id that is not on file.                                                                  |
| `validatedAt`        | Set only by validation. A problem without it cannot be served. `write_problem` always clears it.                                                                                                                                                     |
| `revealFailingInput` | Whether a failed Submit may show the candidate the first failing hidden input. Defaults to the global setting (true).                                                                                                                                |

## statement.md

Markdown, in this shape:

```markdown
## Problem

Plain prose: the setting, the input, what to return. Name every parameter in
backticks. Say what happens at the edges (empty input, no valid answer).

## Examples

**Example 1**
```

Input: temps = [2, 1, 5, 1, 3, 2], k = 3
Output: 9

```

One sentence on why.

## Constraints

- `1 <= len(temps) <= 10^5`
- `-10^4 <= temps[i] <= 10^4`
- `1 <= k <= len(temps)`

## Follow-up

Optional: the question the interviewer asks after a passing submission.
```

Every example in the statement should be a visible case in `tests.json`, in the same
order, so the candidate can run exactly what they read. The constraints are the
contract: hidden cases stay inside them, and the max-size case sits at their edge.

The statement is original work. It never names another site or links to a problem
elsewhere; validation rejects a statement that mentions LeetCode.

## tests.json

```json
{
  "cases": [
    {
      "id": "ex1",
      "label": "Example 1",
      "visible": true,
      "input": { "temps": [2, 1, 5, 1, 3, 2], "k": 3 },
      "expected": 9
    },
    { "id": "empty", "visible": false, "input": { "temps": [], "k": 1 }, "expected": 0 },
    { "id": "large-random", "visible": false, "gen": "large(100000, 33333)" }
  ]
}
```

| Field        | Meaning                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`         | Unique, 1–32 characters of letters, digits, `-`, `_`. Name what the case tests: `empty`, `single`, `best-at-end`, `all-negative`.                                              |
| `label`      | Shown to the candidate for visible cases. Hidden cases are shown as "Hidden 1", "Hidden 2", … whatever their label.                                                            |
| `visible`    | Visible cases appear in the statement and run on the Run button. Hidden cases run only on Submit.                                                                              |
| `input`      | Arguments by parameter name, as JSON. Linked lists and trees are arrays, LeetCode style: `[1, 2, 3]` for a list, `[3, 9, 20, null, null, 15, 7]` for a tree in level order.    |
| `gen`        | Instead of `input`: a Python expression evaluated inside `generators.py` that returns the argument dict. Hidden cases only. Generated inputs are never shown to the candidate. |
| `expected`   | The expected output. Omit the key to make an oracle case: validation runs the reference and writes its output here. An explicit `null` expects `None`.                         |
| `compare`    | `exact` (default), `unordered`, `unordered-nested`, `float`, `any-of`, or `checker`. See below.                                                                                |
| `tolerance`  | For `float`: relative tolerance, default `1e-6`.                                                                                                                               |
| `outputFrom` | For in-place problems: the parameter whose value after the call is treated as the output.                                                                                      |

### Compare modes

- `exact`: deep equality after canonicalisation (object keys sorted, `-0` is `0`).
- `unordered`: the top-level list is compared as a multiset. For "return the indices in any order".
- `unordered-nested`: a list of lists where neither the outer nor the inner order matters. For "group the anagrams".
- `float`: numbers compared within `tolerance`, recursively.
- `any-of`: `expected` is a list of acceptable outputs; any exact match passes. An oracle `any-of` case is filled with a one-element list.
- `checker`: `checker.py` decides. Use it when the space of right answers is too large to list.

### What the harness does with values

Arguments are deep-copied per case, so a solution that mutates its input cannot leak
into the next case. Return values are normalised before comparison: tuples become
lists, sets become sorted lists, `ListNode` chains and `TreeNode` trees become their
array forms. A `None` returned for a declared `ListNode` or `TreeNode` becomes `[]`.
Method-style problems get a fresh `Solution()` per case.

## reference.py

The optimal solution, complete and importable on its own: imports first, then the
function or class the signature names. `from chud_types import ListNode, TreeNode`
when the signature uses them. It is run by validation under a one-second per-case
limit, so a reference that is slower than its complexity target fails validation on
the max-size case, by design. It is never shown to the candidate.

## hints.json

```json
{
  "levels": [
    {
      "level": 1,
      "text": "Recomputing every window from scratch costs O(n·k). What stays the same between one window and the next?"
    },
    {
      "level": 2,
      "text": "When the window slides, one element enters and one leaves. Adjust a running sum by those two."
    },
    {
      "level": 3,
      "text": "Initialise the sum with the first k elements, then for each i from k add temps[i], subtract temps[i-k], track the max."
    }
  ]
}
```

Two to four hints, 1-based and sequential, each more specific than the last: a
question about the structure of the problem, then the key observation, then the
mechanism, then (for hard problems) the step that makes it work. Never code. Each hint
taken is recorded and costs the candidate in the Time score.

## generators.py

Functions that build large inputs. Each returns a dict of arguments by name and
takes its size and a seed as parameters, so the case is reproducible:

```python
import random


def large(n: int, k: int, seed: int = 1) -> dict:
    rng = random.Random(seed)
    return {"temps": [rng.randint(-10_000, 10_000) for _ in range(n)], "k": k}
```

A case refers to it as `"gen": "large(100000, 33333)"`. Use a generator for every
max-size case, including when the input is a single integer at its limit, so that
validation can tell the case is the max-size one.

The input is built again on every run, so the generator must build the same input
every time. Draw every random choice from `random.Random(seed)`. Runs pin
`PYTHONHASHSEED`, so even the iteration order of a set of strings repeats, but an
explicit order is clearer. Validation runs the reference twice when it fills in a
generated case and fails the problem if any generated case comes out differently.

## checker.py

```python
def check(input: dict, actual, expected) -> bool:
    ...
```

Called for cases with `"compare": "checker"`, with the case's input, the solution's
normalised output, and the case's `expected` (the reference's output, once validation
has filled it). Return `True` to pass. Keep it fast; it runs inside the candidate's
time limit.

## Validation

`validate_problem` does two things, and a problem is validated only when both pass.

**Lint** checks the shape:

- at least 2 visible cases and at least 6 hidden cases;
- at least one max-size case: a `gen` case, or a literal input holding 1,000 or more
  elements across its arguments;
- no two cases with the same literal input;
- 2 to 4 hints, all different;
- `complexityTarget.time` and `.space` written as `O(...)`;
- a `## Constraints` section in the statement, and no mention of LeetCode;
- `source.mimicOf` present when `source.kind` is `mimic`.

**The run** executes `reference.py` against every case with the `validate` limits from
`config.json` (one second per case, thirty seconds wall clock by default):

- every case with an authored `expected` must match the reference's output under the
  case's compare mode; a mismatch means the case or the reference is wrong, and the
  report says which case so the author can trace it by hand;
- no case may error or time out;
- every case without `expected` is filled from the reference's output and written
  back to `tests.json`.

On a full pass `meta.json` gets `validatedAt` and `validation: {passed, total}`. On any
failure a previous `validatedAt` is removed. `write_problem` always clears it, so a
fixed bundle has to be validated again.

## The hidden-test checklist

Hidden cases exist to catch the solutions that pass the examples. Cover:

- empty input, where the constraints allow it, and the smallest allowed input;
- a single element;
- all elements equal, and duplicates in general;
- zero and negative values where the constraints allow them;
- the answer at the first position and at the last position;
- an input where the obvious greedy or brute-force approach gives the wrong answer;
- the maximum size from the constraints, built by a generator, with a shape that makes
  a solution one factor too slow fail: for an O(n) target, n = 10^5 with k = n/3 is
  fatal to O(n·k).

Six hidden cases is the floor the lint enforces, not the target.

## Mimic problems

When the user names a real problem ("something like Two Sum"), the interviewer writes
an original problem that drills the same pattern under the same kind of constraints:
the same input sizes and value ranges, the same twist that makes the pattern
necessary, a different story, different objects, different examples. `source.kind` is
`mimic` and `source.mimicOf` holds the title, so the debrief can say what it was
modelled on. The candidate should recognise the technique, not the problem. The
statement of the real problem is never reproduced, and the seed lists hold nothing
but titles, difficulty, and patterns.
