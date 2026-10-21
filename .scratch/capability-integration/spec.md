# UI capability integration — specification

Status: **complete.** All 18 tickets of the breakdown are implemented, verified and merged: 01, 02, 03, 04, 07, 10, 12,
14, 16 and 17 landed on `integration/ux-follow-up`; 05, 06, 08, 09, 11, 13, 15 and the closing pass 18 landed on
`integration/ux-wave3`, which the parent fast-forwards to. Per-ticket status, evidence and review notes are in
[issues/](issues/); the order and edges are in [the breakdown](ticket-breakdown.md). The product owner confirmed the
testing seams exactly as proposed in [Testing Decisions](#testing-decisions) on 2026-10-11. Nothing in this
specification authorizes runtime configuration or deployment.

Source design evidence, decisions and framework facts: [design notes](design-notes.md) and the route manifest in
the vendored snapshot README (`../../apps/web/vendor/pi-web/app/README.md`). Vocabulary follows
[the glossary](../../GLOSSARY.md); the submission rules the specification must not weaken are
[ADR 0006](../../docs/adr/0006-durable-submission-lifecycle.md).

Scope blocks: **A** session sidebar and shared UI state, **B** session management, **C** Projects, folders and
worktrees, **D** the execution-host terminal, **E** MCP on the Web host, **F** durable extensions. Nothing outside
these six blocks is specified.

## Problem Statement

The copied pi-web presentation is already in place — sidebar, tree, search, project/worktree picker, directory
picker, terminal panel, MCP dialogs, extensions panel — but the interfaces behind a large part of it answer "not
connected yet". The user sees working-looking controls that fail: session rows cannot be renamed, deleted, forked,
pinned, archived or reordered across clients; content search does not exist; a Project cannot be removed or have a
folder unlinked; worktrees cannot be listed or managed; the terminal cannot be opened; MCP cannot be configured or
signed in; installed durable extensions cannot be listed or enabled. A user also cannot tell an unsupported control
from a broken one, because both look the same until clicked, and the failure arrives as an opaque refusal.

Two further problems come from the architecture rather than from missing wiring. The durable runtime records
conversations but has no deletion, no title metadata and no content index, so anything the UI expects of those must
be hepi-owned state and must be honest about what it really does. And a conversation binds one Project folder for
its life, while a folder's host is named by its Project — so removing Project metadata without care silently costs
an already-bound conversation its execution environment, with no error shown.

## Solution

Wire the existing presentation to real behaviour through the seams this repository already has, and make every
remaining unsupported control visibly unavailable rather than a hidden refusal.

- **A** Sidebar pins, archive, project order, unread and running state are read and written as one shared hepi
  document per deployment, so two windows of one backend see the same sidebar.
- **B** Rename, delete, fork, auto-name and full-body search become real session operations: rename and delete are
  hepi-owned conversation state; fork uses the runtime's own fork; search is bounded scanning over real history;
  auto-name runs only when asked.
- **C** Projects gain removal and folder unlink, which remove metadata and never a directory; a folder that a
  conversation is already bound to stays resolvable through a retained binding, so no bound conversation loses its
  tools. Worktrees become a real execution-host capability with upstream's semantics.
- **D** The terminal opens a real interactive shell on the conversation's execution host, with input, resize,
  output, reconnect and termination.
- **E** MCP configuration, test and sign-in run on the Web host, owned by the service that runs there, with
  configuration and credentials staying on that host and never on the backend.
- **F** Installed durable extensions are listed and enabled/disabled, with a global default for new conversations
  and per-conversation overrides, using the framework's own extension layers.

Everything else keeps its current behaviour: the Settings surfaces that are not in these six blocks stay visibly
unavailable, no control is presented as functional while it refuses, and the models configuration that already
works is left alone.

## User Stories

### A. Session sidebar and shared UI state

1. As a user, I want my sidebar pins to survive a reload, so the sessions I care about stay where I put them.
2. As a user, I want my archived sessions to stay archived across reloads, so a tidied sidebar stays tidy.
3. As a user, I want a pinned session to appear in the pinned band immediately, so the change I made is what I see.
4. As a user, I want an archived session to leave the active list immediately, so archiving feels like one action.
5. As a user, I want pinning an archived session to restore it, so the two states cannot contradict each other.
6. As a user, I want archiving a pinned session to unpin it, so one session is never in both bands.
7. As a user, I want to undo a bulk archive, so a mistaken bulk action is recoverable.
8. As a user, I want a bulk pin or archive to apply to every session I selected, so a large selection is one intent.
9. As a user, I want the sidebar state to be shared between two open windows of the same backend, so a change in one
   window shows in the other.
10. As a user, I want a change made in another window to arrive without a full page reload, so both windows stay
    coherent.
11. As a user, I want to reorder my projects by dragging or by moving one up or down, so the order I see is the order
    I chose.
12. As a user, I want a project's order to persist across reloads, so my arrangement is not undone.
13. As a user, I want a project that is not currently shown to keep its saved place, so it returns where it was.
14. As a user, I want to pin a project, so my most-used project sits above the rest.
15. As a user, I want a project's order change to land next to the band boundary when it is pinned or unpinned, so
    the move matches what I saw.
16. As a user, I want my sidebar changes to be applied optimistically and then confirmed, so the sidebar does not
    wait on the network to feel responsive.
17. As a user, I want a refused sidebar change to leave the sidebar in its previous state, so a rejection never
    leaves me looking at a lie.
18. As a user, I want an entry for a session that no longer exists to be harmless, so stale sidebar state never
    breaks the list.
19. As a user, I want the running indicator to keep coming from the catalogue I already read, so the running poll
    stays cheap.
20. As a user, I want unread and running markers to stay consistent with the shared state, so a marker never
    contradicts the list.

### B. Session management

21. As a user, I want to rename a session, so my list is readable instead of a wall of first messages.
22. As a user, I want a rename to survive a reload and a restart, so the name is real state and not a display tweak.
23. As a user, I want a session name to be visible in the catalogue without opening the session, so the list needs no
    per-session request.
24. As a user, I want to generate a session name on demand, so I can name a session without inventing a name.
25. As a user, I want auto-naming to happen only when I ask for it, so my own names are never overwritten.
26. As a user, I want a name I typed to be kept even if a later auto-name is requested, so an explicit choice wins
    until I ask again.
27. As a user, I want to delete a session from my list, so a session I am finished with stops taking space.
28. As a user, I want a deleted session to disappear from the list and from search, so deletion is consistent
    everywhere I look.
29. As a user, I want a deleted session's pins and archive entries to be cleared with it, so no orphan state remains.
30. As a user, I want deleting a parent session to handle its children coherently, so I never end up with sessions
    that point at a parent that is gone.
31. As a user, I want deletion to work on a session that is currently running, so I am not blocked by an active run.
32. As a user, I want a failed deletion to say what failed, so I can decide what to do next.
33. As a user, I want to fork a session at a chosen point, so I can explore an alternative without losing the
    original.
34. As a user, I want a forked session to carry the history up to that point, so the branch starts from what I had.
35. As a user, I want a forked session to appear in my list immediately with its own row, so I can continue in it.
36. As a user, I want a fork from an unsaved, empty, missing or subagent session to be refused with a readable
    reason, so I know why the action is unavailable.
37. As a user, I want forking not to disturb the source session's live run, so branching is safe while I am working.
38. As a user, I want to search the full text of my sessions, so I can find a past decision by its content.
39. As a user, I want search to cover whole conversations and not only the first message, so a match deep in a
    transcript is findable.
40. As a user, I want a search result to name the session and the matching excerpt, so I can pick the right one.
41. As a user, I want search to be bounded in time and in result count, so one search cannot stall the UI.
42. As a user, I want a search that hit its bound to say it was truncated, so I know there may be more.
43. As a user, I want an over-long query to be refused with a readable reason, so the limit is not a silent failure.
44. As a user, I want search to work without a separate index to maintain, so results reflect history as it is now.
45. As a user, I want opening a session from a search result to take me to that session, so search is a way in and not
    a dead end.

### C. Projects, folders and worktrees

46. As a user, I want to remove a Project I no longer need, so my project list reflects what I actually use.
47. As a user, I want removing a Project to leave every directory on disk untouched, so a metadata action can never
    destroy my files.
48. As a user, I want removing a Project to leave my conversations intact, so tidying metadata never deletes history.
49. As a user, I want a conversation that was bound to a removed Project's folder to keep running its tools, so
    removing metadata cannot silently break an existing conversation.
50. As a user, I want a removed folder's root to stay registered on its host, so a conversation bound to it keeps
    resolving after a gateway restart.
51. As a user, I want a workspace id to never be reused for a different directory, so a retained binding can never
    point at the wrong folder.
52. As a user, I want to unlink one non-default folder from a Project, so I can correct a Project without rebuilding
    it.
53. As a user, I want removing the default folder to require naming a replacement, so a Project is never left without
    a default.
54. As a user, I want removing the last folder of a Project to remove the Project in the same action, so I never see
    an empty Project.
55. As a user, I want a retained folder to be excluded from the new-session target picker, so I cannot accidentally
    start work in a folder that is no longer a Project folder.
56. As a user, I want a retained folder never to be offered back or silently reused, so re-adding a directory as a
    new Project folder is an explicit act with a new workspace id.
57. As a user, I want a conversation's display root to keep resolving for a retained folder, so an old conversation
    still shows where it runs.
58. As a user, I want the "use default directory" and home answers to come from real Project folders, so those
    actions never point at a folder that was unlinked.
59. As a user, I want to list the worktrees of a Project, so I can see the branches checked out on that host.
60. As a user, I want to create a worktree with a chosen branch, so I can work on a branch without disturbing the
    main checkout.
61. As a user, I want creating a worktree to require an existing folder and a branch, so a bad request fails before
    anything is written on the host.
62. As a user, I want to remove a worktree, so a checkout I am finished with is cleaned up.
63. As a user, I want removing a dirty worktree to be refused unless I explicitly force it, so I cannot lose
    uncommitted work by accident.
64. As a user, I want the refusal to say the worktree is dirty, so I can decide whether to force it.
65. As a user, I want a worktree operation on a host that cannot serve it to say so plainly, so I know the limit is
    the host and not my input.
66. As a user, I want the worktree list to fall back to the Project root when a worktree is already gone, so a stale
    entry does not break the picker.

### D. Execution-host terminal

67. As a user, I want to open a terminal on the conversation's execution host, so I can run commands where the work
    happens.
68. As a user, I want the terminal to start in the conversation's workspace folder, so it opens where I expect.
69. As a user, I want keystrokes to reach the shell, so the terminal is interactive.
70. As a user, I want to resize the terminal, so full-screen programs lay out correctly.
71. As a user, I want output to stream as it is produced, so a long command shows progress.
72. As a user, I want to reconnect to a terminal after a dropped connection, so a network blip does not end my
    session.
73. As a user, I want a reconnected terminal to show the output I missed, so I can follow what happened.
74. As a user, I want a replayed terminal to be bounded, so a huge output cannot be replayed without limit.
75. As a user, I want closing a terminal to end the process on the host, so I do not leave shells running.
76. As a user, I want a terminal that failed to connect to close rather than trap the tab, so the earlier fix is
    preserved.
77. As a user, I want shell input never to be replayed after an ambiguous failure, so a network error cannot run a
    command twice.
78. As a user, I want an exited terminal to report its exit, so I can see how a command finished.
79. As a user, I want a terminal on a host that cannot serve one to say so plainly, so the limit is visible.

### E. MCP on the Web host

80. As a user, I want to see the MCP servers configured for my Web host, so I know what is available to me.
81. As a user, I want to add an MCP server, so I can extend what my assistant can reach.
82. As a user, I want to edit or remove an MCP server, so my configuration stays current.
83. As a user, I want a test action that reports whether a server can start and answer, so I can fix a broken entry.
84. As a user, I want a test failure to report a masked, useful reason, so a bad entry is diagnosable without
    leaking a secret.
85. As a user, I want to sign in to a server that needs OAuth, so a protected server becomes usable.
86. As a user, I want to sign out of a server, so a credential I no longer want is removed.
87. As a user, I want my MCP configuration to live on the Web host, so it is mine on the machine I use and not
    something the backend holds.
88. As a user, I want my MCP credentials to stay on the Web host, so a secret is never handed to the backend.
89. As a user, I want project-scoped MCP configuration to be gated by my trust decision for that folder, so a folder I
    have not trusted cannot add servers.
90. As a user, I want the MCP surface to say when no host service can serve it, so I am not left guessing.

### F. Durable extensions

91. As a user, I want to see the durable extensions installed on this backend, so I know what is available.
92. As a user, I want to enable or disable an installed extension globally, so the default for my new conversations is
    what I chose.
93. As a user, I want my global extension default to survive a restart, so I do not re-choose it every session.
94. As a user, I want a global default change to apply to new conversations, so I can change my mind without
    disturbing work in progress.
95. As a user, I want an existing conversation to keep the extension selection it was created with, so a change to
    the default never rewrites history.
96. As a user, I want to override the extension selection for one conversation, so a single session can differ from
    my default.
97. As a user, I want a conversation's own selection to survive a reload, so my override is real state.
98. As a user, I want a disabled extension's tools to stop being offered in the conversations that no longer select
    it, so disabling has an effect.
99. As a user, I want an extension that fails to install at startup to be reported, so a broken extension is visible
    rather than silently absent.
100. As a user, I want the extensions surface to offer only what it can do, so I am never shown an install, update or
     check action that cannot work.
101. As a user, I want to bulk-toggle several extensions at once, so a selection change is one action.
102. As a user, I want an extension to own its own settings surface, so I am not shown a generic editor that cannot
     know what an extension needs.

### G. Truthfulness, lifecycle and cross-cutting

103. As a user, I want every control I am shown to either work or be visibly unavailable, so I never have to click
     to discover that a feature is missing.
104. As a user, I want a refusal to name what was refused and why, so I can act on it.
105. As a user, I want a failure that the backend answered to be shown as that failure, so a rejection is never
     disguised as a success or as an empty result.
106. As a user, I want a transport failure to be shown as a transport failure, so an unknown outcome is never
     presented as a definite one.
107. As a user, I want sending a message to admit exactly one turn, so a retry after a dropped connection cannot
     produce a duplicate.
108. As a user, I want a pending turn to stay on screen until it is committed or its outcome is known, so a slow run
     is never mistaken for a lost message.
109. As a user, I want an unknown submission outcome to be looked up rather than resent, so recovery never duplicates
     a turn.
110. As a user, I want a rejected send to restore my draft, so I can resend deliberately.
111. As a user, I want the catalogue to be honest about what it does not know, so fields the runtime cannot supply are
     absent rather than fabricated.
112. As a user, I want timestamps the runtime cannot supply to stay empty, so a placeholder is never read as a fact.
113. As a user, I want the models configuration that already works to keep working unchanged, so this effort does not
     regress what is delivered.
114. As a user, I want a Settings surface outside these six blocks to remain visibly unavailable, so its state is
     unchanged and visible rather than newly broken.

## Implementation Decisions

Decisions are grouped by scope block. Each is marked **(confirmed)** when the product owner decided it, or
**(inferred)** when it is a technical default this specification proposes and the testing-seam confirmation covers.
No module path, route string or code fragment appears here; the source design evidence linked above carries those.

### A. Sidebar and shared UI state

1. **(confirmed)** Pins, archive and project order are stored as one hepi session-scoped document per backend, not as
   a file on a Web host. One document serves every client of one backend, which is what makes two windows agree.
2. **(confirmed)** The pure rules the client already applies optimistically are the same rules the backend applies, so
   an optimistic change and a confirmed change cannot diverge.
3. **(confirmed)** The state is written by one change per request, and the answer is the state after the change, so a
   client never has to guess what the server did.
4. **(confirmed)** An entry for a session or project that is no longer shown is harmless and is kept, so a returning
   project takes its old place.
5. **(inferred)** Concurrency is last-write-wins per request with the backend as the only writer, and no client-side
   merge or lock is introduced. A multi-window conflict therefore resolves to whichever request the backend applied
   last, which is what the shared document makes observable.
6. **(confirmed)** Session delete clears that session's pin and archive entries as part of the same operation.
7. **(confirmed)** The document is versioned, and a document of another version is not read as this one.

### B. Session management

8. **(confirmed)** Session title and rename are hepi conversation-scoped state, because the runtime's conversation
   record has no title and cannot filter on one. No framework change is proposed or needed.
9. **(confirmed)** Session delete is a hepi-owned tombstone that hides the conversation from the catalogue. The
   runtime has no conversation or entry deletion, so the records are retained, and the operation is presented as an
   ordinary removal with no statement or implication of non-permanence.
10. **(confirmed)** No direct database deletion is performed for session delete: the tombstone is written through the
    same durable document path as any other hepi state.
11. **(confirmed)** The owning seam of the tombstone carries a comment recording that records are retained because the
    runtime lacks a deletion primitive, and that it should be replaced when that primitive exists.
12. **(confirmed)** Fork uses the runtime's own conversation fork with its fork-aware history and document semantics.
    The contract to honour is the upstream one: answer with the new session identity and its catalogue row, and refuse
    a missing, unsaved, empty or subagent source with a readable reason.
13. **(confirmed)** Fork does not stop or disturb a live run in the source conversation.
14. **(confirmed)** Search reads conversation entries through the runtime's public paginated reads and applies the
    upstream matcher, limits and response shape; only the reading half changes, because a durable conversation is not
    a file to stream. Bounded concurrency, a bounded result count and a bounded time budget are part of the contract.
15. **(confirmed)** No search index is introduced. Bounded scanning is the upstream answer and is reused as the
    decision, not as a temporary measure.
16. **(confirmed)** Auto-name runs only on an explicit request. The upstream title entry point drives a session type
    this backend does not own, so the reusable parts are the transcript budget and the prompt shape; the generation
    call is made from what the backend has.
17. **(confirmed)** Catalogue timestamps the runtime cannot supply stay empty rather than being filled with a
    placeholder.

### C. Projects, folders and worktrees

18. **(confirmed)** Removing a Project removes the project record and its folder links. No directory is touched, no
    conversation is deleted, no workspace id is reused, and no host registration is undone.
19. **(confirmed)** Removing a folder unlinks it; the folder's workspace binding is retained so a conversation already
    bound to it keeps resolving its host, its root and its execution environment.
20. **(confirmed)** Retention is a storage addition written in the same transaction as the removal, additive to the
    existing schema and changing nothing about the existing project, folder or default-folder records. This is a
    technical default settled in the design pass; it is not reopened here.
21. **(confirmed)** Nothing scans conversations to decide a removal, so no removal is refused because conversations
    are bound and no bound-conversation count is computed.
22. **(confirmed)** A retained binding is never pruned and never offered back. A workspace id is minted per folder and
    the host refuses a different root for an id it already holds, so a retained id cannot be re-pointed.
23. **(confirmed)** A retained binding stays in the workspace list so a bound conversation's display root resolves,
    and carries a marker that excludes it from every target picker and from the home and default-directory answers.
24. **(confirmed)** The default folder is never removed on its own: a request that removes it names the replacement in
    the same call, and removing the last folder removes the Project in the same transaction.
25. **(confirmed)** Removing a non-default folder has its own control; the default selector is not the whole surface.
26. **(confirmed)** Worktrees are in scope as an execution-host capability, not as an adapter gap: the gateway's
    workbench surface is read-only and an SSH gateway serves no workbench at all, so the operation does not exist yet
    and must be added at the host.
27. **(inferred)** Worktree semantics follow the upstream contract as-is: list falls back to the inferred Project root
    for a worktree that is already gone; create requires an existing folder and a branch; remove requires an explicit
    force and answers a dirty refusal as a distinct, readable outcome. The exact dirty-refusal status and the force
    prompt wording are a proposal, not a user decision.
28. **(inferred)** A host that cannot serve a worktree or terminal operation answers with a plain, named limit rather
    than a generic refusal. This is a proposal about how the limit is reported.
29. **(inferred)** Removing a Project or unlinking a folder does not attempt to unregister the root on its host,
    because no such host operation exists; the retained record is what re-registers the root after a host restart.

### D. Execution-host terminal

30. **(confirmed)** The terminal is a real interactive shell on the conversation's execution host, reached through
    that host's existing authenticated execution surface, not a shell on the Web or backend host.
31. **(confirmed)** The terminal opens in the conversation's bound workspace folder.
32. **(confirmed)** The existing browser terminal behaviour is preserved: input is never replayed after an ambiguous
    delivery failure, a failed connection closes its tab rather than trapping it, and a resize is applied.
33. **(inferred)** The reconnect window, the replayed-output bound and the terminal's exit reporting are proposed
    defaults, not user decisions. They must be stated explicitly in the ticket that implements them, and they are
    confirmed or changed at the same time as the testing seams.
34. **(inferred)** Terminal output is not added to the durable conversation transcript. It is a host session with its
    own lifecycle, and the transcript stays what it is.
35. **(confirmed)** The host operation the terminal needs is a long-lived session with input, resize and termination,
    which the current per-call execution surface does not model; adding it is the substance of this block.

### E. MCP on the Web host

36. **(confirmed)** MCP belongs to the Web host: its account, its filesystem and its configuration. The Web process is
    a presentation and proxy layer with no session and no agent loop, so it is not the owner of MCP server processes.
37. **(confirmed)** The owner is the service that already runs on the Web host beside the Web container, as a new
    operation on its authenticated surface. A separate new host service is rejected.
38. **(confirmed)** MCP configuration and OAuth state are files owned by that Web host service, in the upstream shapes
    for a global scope and a project scope, with OAuth state beside them.
39. **(confirmed)** No MCP credential, token or secret is sent to or stored by the backend. The backend is not an MCP
    participant.
40. **(confirmed)** The MCP surface is gated by the existing project trust decision for a folder, reusing the trust
    store rather than adding a per-tool sandbox.
41. **(confirmed)** Test and sign-in reuse the upstream request and response shapes, with secrets masked in every
    reported reason.
42. **(inferred)** Which concrete host operation carries MCP (a spawn-and-stream operation, a bridge, or a separate
    port) is left to the ticket. The specification fixes the owner, the placement and the secret boundary, not the
    transport.

### F. Durable extensions

43. **(confirmed)** "Extensions" means pi-durable extensions exclusively: the extension objects installed in the
    backend's registry and selected by name. Nothing else may be called an extension in this work.
44. **(confirmed)** Pi packages, the Pi package manager and any Agent Plugins bundle integration are out of scope and
    are research references only. Nothing is installed, updated, checked or adapted from an online source, and no
    compatibility layer for a bundle format is built or reserved.
45. **(confirmed)** The surface lists installed extensions and enables or disables them. Install, remove, update and
    check are not offered.
46. **(confirmed)** The global default selection is stored as hepi application state and applies to new
    conversations. The runtime's harness-wide default is documented as read at every resolution and never copied, so
    relying on it alone would move the selection under conversations that never made a choice; the persisted default
    is therefore hepi-owned, and the claim that the runtime persists it natively is not made.
47. **(confirmed)** Each conversation's extension selection is materialized explicitly when the conversation is
    created, and a per-conversation override writes that conversation's own selection. An existing conversation keeps
    the selection it was created with when the global default changes.
48. **(confirmed)** The installed set comes from the runtime's registry; the selected set comes from the framework's
    own per-conversation selection field. No parallel extension registry is introduced.
49. **(confirmed)** An extension that fails to install at startup is reported at startup rather than silently absent.
50. **(confirmed)** Each extension owns its own settings surface and its own stored documents. No generic
    per-extension editor is built, because the framework gives an extension no configuration surface to drive one.
51. **(confirmed)** The bulk-toggle behaviour of the existing settings panel is reused for selecting several
    extensions at once.

### G. Truthfulness, lifecycle and cross-cutting

52. **(confirmed)** Every control the UI presents either performs its action or is visibly unavailable. A control
    that cannot work is not shown as functional and does not answer a hidden refusal.
53. **(confirmed)** Where a capability is genuinely absent, the surface says what is absent in plain language, and the
    surrounding capability keeps working.
54. **(confirmed)** A backend-answered failure is surfaced as that failure with its reason. A transport failure is
    surfaced as a transport failure. Neither is converted into an empty success.
55. **(confirmed)** The submission rules are preserved exactly: the browser generates the request identity, admission
    deduplicates by it, a pending turn is shown until committed or resolved, a settlement is delivered as a frame, and
    an unknown outcome is looked up rather than resent.
56. **(confirmed)** Only a readable rejection restores the draft.
57. **(confirmed)** Upstream sources are reused as preserved bytes with their licence and provenance recorded, and no
    second runtime is created beside the durable one. Nothing vendored is placed on a runtime import path.
58. **(confirmed)** The models configuration that already works is not rewritten, not re-plumbed and not regressed by
    any block here.
59. **(confirmed)** No file watching, no workspace file upload and no package installation is authorized by this
    specification. Those remain unsupported and are listed as such.

## Testing Decisions

### What makes a good test here

A test asserts externally observable behaviour at a public seam: a request a real client makes and the answer it
gets, or a real host effect that can be inspected afterwards. A test that mirrors an implementation's internals, that
reaches into a module to check a private step, or that asserts a mechanism rather than an outcome does not belong
here. Determinism is required: no sleeps to wait for a state, no paid model calls, no dependence on a live external
service, and no test that only passes on the machine it was written on. Bounds are asserted as bounds — a truncated
result is checked for its truncation marker, not for a particular number of items. Failures are asserted as the exact
outcome and reason the caller can see, never as "some error".

Verification claims follow [verification practice](../../docs/agents/verification.md): a reported check names the
command, the revision it ran against, the exit code and the log, and a comparison is against a pinned revision rather
than the tree in front of the author. Findings are triaged by [review policy](../../docs/agents/review-policy.md).

### Proposed seams

The proposal is three seams, in the order they should be preferred. The confirmation request is that these are the
right seams and that nothing here needs a fourth.

**Seam 1 — browser → existing Web adapter → durable backend (the highest seam).** Every block's user flow is
asserted through a real browser against the real Web adapter and a real backend with a real store, because that is
what a user does. This covers the whole of A, the rename, delete, fork, search and auto-name flows of B, the
Project/folder removal and retained-binding flows of C, the extension list/enable/disable and default/override flows
of F, and every truthfulness story in G. It is one seam for six blocks, which is why it is the preferred one.

**Seam 2 — the execution host's public contracts, local and over an isolated localhost SSH host.** Filesystem, Git
and worktree behaviour, terminal sessions and the host-side MCP operation are asserted against the gateway's public
surface, both as a local gateway and as an SSH gateway driven by the existing isolated-sshd fixture. This is the
second seam because the host boundary is where these behaviours actually differ between a local and a remote
execution host. It covers C's worktree behaviour, D entirely, and the host half of E.

**Seam 3 — controlled fake model and fake MCP fixtures.** OAuth flows, subagent behaviour and conversation lifecycle
outcomes are asserted against a controlled local fake rather than a real provider or a real remote server, so the
outcome is deterministic and costs nothing. A real-provider smoke remains an optional, bounded, operator-run
verification and is never part of the default suite. This seam covers the lifecycle stories in G and the sign-in and
test stories in E that would otherwise need a network.

### Modules and prior art

Modules under test, and the existing suites they follow:

- The durable backend's public HTTP surface, following the existing backend server, project, submission and
  provider-configuration suites.
- The Web adapter seam, following the existing browser-driven end-to-end scripts, including their pattern of starting
  the same processes a deployment composes and recording what the browser actually asked for.
- The gateway's public surface, following the existing gateway, filesystem, worktree and SSH suites, including the
  isolated-sshd fixture and its availability guard.
- The shared sidebar-state rules, following the existing pure-rule suites: a pure function is tested directly for its
  rules and again through the adapter for the request and response contract.

### Coverage obligations

- A, B, C, F: one browser-driven end-to-end path per user-visible operation, plus pure-rule coverage for the shared
  sidebar rules.
- C, D: the same behaviour asserted on a local gateway and on an SSH gateway, with the SSH half skipped only when the
  fixture is genuinely unavailable on the runner, and the skip reported rather than hidden.
- D: terminal input, resize, reconnect, replay bound and termination each asserted as an observable outcome, with no
  sleep-based waiting.
- E: test and sign-in asserted against a controlled fake, with a masked-secret assertion that no secret appears in any
  reported reason, and an assertion that no MCP secret reaches the backend.
- F: the global default and the per-conversation override asserted to diverge as specified, including the case where
  the global default changes after a conversation exists.
- G: the submission invariants of the ADR are re-asserted as regression coverage, because this effort touches the
  surfaces around them.
- Every block: an assertion that a genuinely unsupported control is visibly unavailable rather than refusing.

## Out of Scope

- **The models configuration that already works.** It is not rewritten, re-plumbed or regressed.
- **Pi packages, the Pi package manager, Pi plugins and any Agent Plugins bundle format.** Research references only:
  nothing is installed, updated, checked, adapted or shimmed, and no seam is reserved for a bundle format.
- **Any alleged third-party harness extension standard.** Out of scope until separate research reports; if it reports
  a real and loadable standard, it becomes a new decision rather than a prepared adapter.
- **File watching, workspace file upload, linked-directory approval, binary preview or download, DOCX preview and
  additional preview chunks.** Unchanged and unsupported.
- **Session export, entry-level browsing beyond what the current session view already reads, branch-tree navigation
  and advanced session mutations beyond the operations named in block B.**
- **Runtime lease and full-output retrieval, open-in-explorer, app-update, push notifications, provider usage
  queries, provider credential and OAuth flows for model providers, subagent configuration, tool settings, web
  authentication reconciliation and project trust write.** These Settings and adjacent surfaces stay as they are and
  stay visibly unavailable; they are not part of this specification.
- **Cross-host or cross-platform Projects, secondary-folder prompt inclusion and access grants, and relocation of an
  existing conversation to a different folder.** Existing bindings are immutable here.
- **Any change to the deployment topology, the deployment units or their configuration.** No deployment is performed
  or planned by this specification.
- **Deleting a conversation's records.** The runtime does not offer it, and this specification does not simulate it by
  writing to storage outside the durable API.

## Further Notes

**Grounding.** The six scope blocks and the decisions marked *confirmed* come from the product owner's decisions in
the design pass: session delete as a tombstone with no non-permanence notice, full-body bounded search with no index,
Project and folder removal as metadata-only with a retained binding, MCP on the Web host, extensions meaning durable
extensions only, enable/disable among installed extensions only, and a global default for new conversations with
per-conversation overrides. The decisions marked *inferred* are technical defaults proposed by this specification,
and they are exactly these: how concurrent sidebar writes resolve (5); the worktree details (27); how a host reports a
capability it cannot serve (28); that no host unregistration is attempted on removal (29); the terminal's reconnect
window, replayed-output bound and exit reporting (33); that terminal output stays out of the transcript (34); and the
concrete host operation that carries MCP (42). They are covered by the testing-seam confirmation and are not treated
as authorized from that date.

**Honest inventory of what stays unsupported.** So that no later reader mistakes this specification for a promise of
general compatibility: the Settings and adjacent surfaces listed under *Out of scope* remain unsupported, and the
specification deliberately does not enumerate a plan for them. Anything not named in blocks A–F keeps its current
behaviour. Where a surface is presented and cannot work, the requirement is that it is visibly unavailable — not that
it is implemented.

**Framework gaps this specification lives with.** The runtime has no conversation deletion, so delete is a tombstone
over retained records. The conversation record carries no title, metadata or timestamps, so names are hepi state and
catalogue timestamps stay empty. There is no content index, so search is bounded scanning. There is no pin, archive or
ordering primitive, so sidebar state is a hepi document. The gateway has no worktree read or mutation, no workspace
unregister and no long-lived session, so blocks C and D add host operations. There is no MCP support anywhere in the
runtime, so block E is a host capability plus a backend surface that reaches it. The extension registry is code-only
with no discovery, loader, package concept or per-extension configuration, which is exactly why block F is
enable/disable among what is already installed.

**Next step.** The ticket breakdown is published as numbered tickets under [issues/](issues/), numbered
blockers-first, with the dispatch order and the dependency edges recorded in
[the breakdown](ticket-breakdown.md). This document does not authorize implementation: each ticket is worked,
verified and reviewed on its own.

## Comments

**2026-10-11 — testing seams confirmed, status set to `ready-for-agent`.** The product owner confirmed the three
proposed seams exactly as written in [Testing Decisions](#testing-decisions): browser end-to-end through the existing
Web adapter and the durable backend; the execution host's public contracts on a real local gateway and on an isolated
localhost SSH gateway; controlled fake model and MCP fixtures, with no paid model calls, no sleeps and every wait an
event or state change. No fourth seam was requested and none is added. The confirmation also covers the decisions
marked **(inferred)**, which are therefore authorized from that date.

The same confirmation authorized this specification to be broken into tickets. The breakdown is
[the ticket breakdown](ticket-breakdown.md) with 18 numbered tickets under [issues/](issues/). Deferred findings that
touch these surfaces, with their dispositions and revisit conditions, are in [review notes](review-notes.md).
