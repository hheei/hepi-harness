# Issue Tracker: Local Markdown

Specs, tickets and review notes for this repository live as Markdown files in `.scratch/`.

## Conventions

- One effort per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation tickets are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order.
- Each ticket includes a `Blocked by:` line and a `Status:` line.
- Append conversation history under a `## Comments` heading when needed.

When a skill says to publish, create or update the relevant Markdown file. When it says to fetch a ticket, read the referenced path. Do not create application code as part of issue publication.

## Review findings

Apply the [review policy](review-policy.md) before creating blocking tickets or another implementation iteration. Record deferred findings under the ticket's `## Review notes`, or in `.scratch/<feature-slug>/review-notes.md` when several tickets share them. Include the trigger, evidence, normal-use likelihood, user impact, disposition, and reason to revisit. Link the note from the relevant ticket.

A `record` disposition is non-blocking: it does not reopen a completed ticket, create a blocking edge, or require defensive code or tests. Resolve the ticket when its agreed work and material fixes are complete, retaining these notes.

## Wayfinder operations

The `wayfinder` skill maps a multi-session effort here.

- Map: `.scratch/<effort>/map.md`, listing the destination, decisions so far, and fog.
- Child decision tickets: numbered files under `.scratch/<effort>/issues/` with `Type:` and `Status:` lines, each holding one question.
- Claim: set `Status: claimed` before work.
- Resolve: append a `## Answer`, set `Status: resolved`, and add a one-line entry pointing at that ticket under the map's Decisions so far.
- Blocking: a ticket is ready when every listed ticket is resolved.
- Refer to a map or ticket by its title in anything the human reads, never by bare id or slug.
