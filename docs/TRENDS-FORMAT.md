# Trends format

`~/.chudcode/trends.json` records what companies have been asking in interviews, as
the agent found it in public interview-experience posts. The `research` skill writes
it with `record_trends`; `begin_interview` reads it when the user names a company, so
the problem they get has the shape that company has been asking lately; and a problem
written from an entry cites it in `meta.source.trendIds`.

```json
{
  "entries": [
    {
      "id": "t-5c1d9a0b2e",
      "pattern": "graphs",
      "company": "Stripe",
      "role": "new grad SWE",
      "difficulty": "medium",
      "seenAt": "2026-09-14",
      "sourceUrl": "https://example.com/posts/stripe-ng-2026",
      "shapeNote": "Grid of cells with blocked squares; count regions reachable from a start, then asked to handle updates that unblock cells.",
      "recordedAt": 1760356800000
    }
  ]
}
```

| Field        | Meaning                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `t-` and ten hex digits, derived from `pattern`, `company`, and `sourceUrl`. Set by the store.                                                              |
| `pattern`    | A pattern id from `data/patterns.json`. One entry per pattern: a post describing two problems on different patterns gives two entries with the same source. |
| `company`    | The company as the post names it, at most 80 characters. Compared ignoring case and spacing.                                                                |
| `role`       | Optional: the role the post was about, as it says it ("new grad SWE", "L4 backend", "intern").                                                              |
| `difficulty` | Optional: `easy`, `medium`, or `hard`, as the post describes it or as the shape implies.                                                                    |
| `seenAt`     | When the interview happened, as the post gives it, written `YYYY-MM-DD`. Use the first of the month when the post gives only a month. Not in the future.    |
| `sourceUrl`  | The post. Normalised on write: lower-case host, no fragment, no trailing slash. At most 500 characters.                                                     |
| `shapeNote`  | One or two sentences: the pattern and the constraints. At most 280 characters, no links. See below.                                                         |
| `recordedAt` | When the entry was written, in milliseconds since the epoch. Set by the store.                                                                              |

## The shape note

The note describes the shape of a problem so that an original problem of the same
shape can be written later. It holds what an interviewer would say when asked "what
kind of thing do they ask": the pattern, the input, its size, the twist that makes the
pattern necessary, and the follow-up if the post mentions one.

It never holds the problem. The cap exists so that a statement cannot fit, and the
link rule exists so that a note cannot point at one. A post that reproduces a real
problem's statement is a source for the pattern and the constraints, nothing more.

Good:

> Longest stretch of a string with at most k distinct characters, n up to 10^5;
> follow-up asked for the count of such stretches.

> Dependency graph of jobs with up to 10^4 edges; return a valid order or report the
> cycle. Asked to explain why DFS colouring finds the cycle.

Not good: an example input and its output copied from the post, the post's wording of
the task, a title that names a problem on another site, or a link.

## Ids and duplicates

An entry is identified by its pattern, its company, and its source. The id is a hash
of those three, so recording the same post again returns the existing id and writes
nothing, however the company is capitalised or the URL is punctuated. A problem that
cites an id in `meta.source.trendIds` keeps pointing at the right entry if the file is
rebuilt from the same sources.

`record_trends` checks every entry in a batch before writing any of them. A batch with
one bad entry writes nothing; the error names each problem by field.

## How the interviewer uses it

`begin_interview` with a `company` includes that company's entries in the brief: each
id, pattern, role, date, and shape note, most recent first, with a tally of the
patterns. The interviewer chooses the shape the company has been asking and writes an
original problem of that shape, citing the entries it drew on in `trend_ids` under
`source` when it calls `write_problem`. Without a `company`, the brief says how many
entries exist and for whom, and nothing more.

`list_trends` shows the entries in the terminal, filtered by company or pattern, for
the user and for the `research` skill to see what is already on file.

## Editing by hand

The file is plain JSON. Remove an entry by deleting it; nothing else refers to it
except `trendIds` in problems that were written from it, which keep working as a
record of what shaped them. Change an entry's note or date freely. An id that no
longer matches its fields is accepted; the store only derives ids when it writes new
entries. A malformed file is an error, not a silent empty list, so a typo shows up on
the next read.
