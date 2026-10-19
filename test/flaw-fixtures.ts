/**
 * A flaw-review drill that passes validation: an agent's diff to a Flask invoices
 * blueprint with five planted flaws and two decoys. The key is not a real one.
 */

import type { FlawSpec } from "../src/drill/flaw-review.ts";

export const DIFF =
  '--- a/app/routes/invoices.py\n+++ b/app/routes/invoices.py\n@@ -1,8 +1,35 @@\n from flask import Blueprint, abort, request\n from app.db import db\n+import os\n+import requests\n+\n+PAYMENTS_API_KEY = "pk-live-0f3c9a7e51"\n+\n+\n+DATABASE_URL = os.environ["DATABASE_URL"]\n+\n invoices = Blueprint("invoices", __name__)\n \n \n @invoices.get("/invoices/<int:invoice_id>")\n def get_invoice(invoice_id):\n-    raise NotImplementedError\n+    row = db.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,)).fetchone()\n+    if row is None:\n+        abort(404)\n+    return dict(row)\n+\n+\n+@invoices.get("/invoices/search")\n+def search_invoices():\n+    q = request.args.get("q", "")\n+    rows = db.execute(f"SELECT * FROM invoices WHERE customer LIKE \'%{q}%\'").fetchall()\n+    return [dict(r) for r in rows]\n+\n+\n+@invoices.post("/invoices/<int:invoice_id>/charge")\n+def charge(invoice_id):\n+    try:\n+        requests.post_json("https://payments.example.com/charges", key=PAYMENTS_API_KEY, id=invoice_id)\n+    except Exception:\n+        pass\n+    return {"ok": True}\n';

export const FLAW_SPEC: FlawSpec = {
  diff: DIFF,
  flaws: [
    {
      id: "hardcoded-key",
      file: "app/routes/invoices.py",
      line: 6,
      category: "secret",
      critical: true,
      explanation:
        "The payments key is committed in source; read it from the environment or a secret store.",
    },
    {
      id: "sql-injection",
      file: "app/routes/invoices.py",
      line: 25,
      category: "injection",
      critical: true,
      explanation: "The search term is formatted into the SQL; pass it as a parameter.",
    },
    {
      id: "missing-authz",
      file: "app/routes/invoices.py",
      line: 19,
      category: "missing-authz",
      critical: false,
      explanation: "Any signed-in user can read any invoice by id; check that it belongs to them.",
    },
    {
      id: "invented-call",
      file: "app/routes/invoices.py",
      line: 32,
      category: "hallucinated-api",
      critical: false,
      explanation: "requests has no post_json; this raises AttributeError on every charge.",
    },
    {
      id: "swallowed-error",
      file: "app/routes/invoices.py",
      line: 33,
      endLine: 34,
      category: "silent-error",
      critical: false,
      explanation:
        "Every failure, including the AttributeError above, is swallowed and the route reports success.",
    },
  ],
  decoys: [
    {
      file: "app/routes/invoices.py",
      line: 9,
      note: "Reading the database URL from the environment is the right way to hold it.",
    },
    {
      file: "app/routes/invoices.py",
      line: 16,
      note: "This query passes the id as a parameter, so it is safe.",
    },
  ],
};

const REVIEW_PARA =
  "An agent's diff reads as confident whether it is right or not, so the review has to look for the failure, not the intent. ";

export const FLAW_TEACHING = [
  "## The review is yours",
  "",
  `You are responsible for reviewing what an agent proposes before you approve it [fact:review-own-changes-before-approval]. ${REVIEW_PARA.repeat(2)}`,
  "",
  "## Automated review helps, and misses things",
  "",
  `An AI review can miss bugs and security issues; no findings does not mean safe [fact:code-review-may-miss-issues]. ${REVIEW_PARA.repeat(2)}`,
  "",
  "## Untrusted input",
  "",
  `Do not pipe untrusted content straight to the agent, and check changes to critical files [fact:avoid-piping-untrusted-content]. ${REVIEW_PARA}`,
].join("\n");

export const FLAW_BRIEF = [
  "## Scenario",
  "",
  "An agent added invoice lookup, search, and charging to a Flask app's invoices blueprint. The tests pass. The pull request is yours to approve.",
  "",
  "## Your task",
  "",
  "Mark every line you would block the merge on, with a category and a reason. Some lines that look wrong are fine. You have three submissions.",
].join("\n");

export function flawArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "review-the-invoices-diff",
    lesson: "review-agent-diffs",
    kind: "flaw-review",
    title: "Review the invoices diff",
    teaching_md: FLAW_TEACHING,
    brief_md: FLAW_BRIEF,
    model_outline:
      "A strong review blocks on the committed key and the SQL built from the search term, asks for an ownership check on invoice reads, notices that requests has no post_json and that the bare except hides it, and leaves the parameterised query and the environment read alone.",
    follow_ups: [
      "What does an attacker control here?",
      "What would the tests have to check to catch the charge bug?",
    ],
    pitfalls: ["Flagging the parameterised query", "Missing the swallowed exception"],
    diff: FLAW_SPEC.diff,
    flaws: FLAW_SPEC.flaws.map((f) => ({
      id: f.id,
      file: f.file,
      line: f.line,
      ...(f.endLine ? { end_line: f.endLine } : {}),
      category: f.category,
      critical: f.critical,
      explanation: f.explanation,
    })),
    decoys: FLAW_SPEC.decoys,
    ...extra,
  };
}
