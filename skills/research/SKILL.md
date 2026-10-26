---
name: research
description: Find out what a company has been asking in coding interviews and phone screens lately, from public interview-experience posts, and save it so the next mock interview or phone screen for that company has the right shape. Use when the user names a company and asks what it asks, wants to prepare for a specific company or its phone screen, or asks to research or update interview trends.
---

# Research

1. Note the company and, if given, the role ("new grad", "intern", "senior backend")
   in the user's request. If no company is named, ask for one and stop.
2. Call `list_trends` from the `chudcode` MCP server with the company, to see what
   is already on file and to get the pattern ids. Tell the user in one sentence how
   many entries exist and how recent the newest is. If they only asked what is on
   file, answer from it and stop.
3. Search the web for recent interview-experience posts about that company and role:
   "<company> <role> interview experience", "<company> coding interview questions",
   "<company> onsite coding round", on forums, blogs, and question boards. Prefer
   posts from the last twelve months with a date and a first-person account of the
   coding rounds, and open those. If this host has no web search or fetch tool, say
   so and stop; do not record what you remember.
4. For each coding problem a post describes, decide the pattern it drills (one id
   from the list `list_trends` gave you), the difficulty if the post says or the
   shape implies, and write a shape note in your own words: the pattern, the input
   and its bounds, the twist that makes the pattern necessary, and any follow-up.
   One or two sentences, at most 280 characters. Never the statement, an example, a
   title from another site, or a link. A post that reproduces a real problem is a
   source for its shape and nothing more.
5. Call `record_trends` once with every entry: pattern, company, role, difficulty,
   the date the interview happened (YYYY-MM-DD; the first of the month when only a
   month is given), the post's URL, and the shape note. Entries already on file are
   skipped, not duplicated. If the tool rejects the batch, fix the fields it names
   and call it again.
6. In the terminal, summarise: how many entries were added, which patterns the
   company asks most, and the roles and dates covered. Offer a mock interview for
   that company; the interview skill shapes its problem after these entries and
   cites them.

Aim for five to ten entries per run from several posts rather than one long one. A
dated, first-person account of a coding round is worth more than a list of titles.

## Phone screens

When the user is preparing for a company's phone screen (or asks what it is like),
research that too. Call `list_phone_briefs` with the company to see what is on file.
Then look for recent posts describing the phone rounds: "<company> recruiter call",
"<company> phone screen", "<company> behavioral interview", "<company> technical
phone screen". For each round a post describes, record its format (`recruiter`,
`behavioral`, `fundamentals`, or `technical`), its length if given, the date, the
post's URL, and a note of at most 400 characters in your own words: who called, what
they asked about, anything unusual (a take-home after, a shared doc, questions on a
specific technology). For a fundamentals round, list the topics with the ids that
`record_phone_briefs` accepts. Save them all with one `record_phone_briefs` call,
summarise the company's phone process in the terminal, and offer a mock phone screen.
