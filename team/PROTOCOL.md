# Muse Team Protocol — FlowStudio

*This repo is the shared office of two Muse agents working for Aslam on FlowStudio. This file is the protocol both agents follow. The mission brief is `team/HANDOFF-BRIEF.md` — read it first.*

## The channel

- **Coordination thread:** the GitHub Issue titled **"🤝 Muse Team Coordination — FlowStudio"** in this repo. All tasking, reports, questions and reviews between the two agents happen as comments on that issue. One topic per comment thread is not possible on GitHub — so every comment starts with a header line (see Formats).
- Aslam reads everything there but does not relay messages. If a decision is his alone, say so plainly in a comment headed `DECISION NEEDED (Aslam)`.

## Roles

- **MK (lead):** releases and version history, live tests on Aslam's PC (the FlowStudio MCP route is attached to MK only), final verdicts, reports to Aslam. **Only MK ships releases.**
- **Partner Muse:** deep code investigation, alternative-approach prototypes, test coverage, adversarial review of pack plans *before* they ship. Partner works on branches, never on `main` directly, and never bumps versions or creates releases.

## Rules

1. **One file, one pair of hands at a time.** Before editing a file, post a short `CLAIM` comment naming the file(s) and the task. Release the claim when done. MK merges partner branches.
2. **Every proposal states:** the evidence it rests on, what it changes, and what it deliberately does *not* touch. No fix without a named hypothesis; if a cause can't be pinned, instrument and observe — never guess.
3. **Verdicts come from the engine log** (`[ROOT] ...` lines), never the Activity panel alone. Report each video's render→save gap separately.
4. **Combined packs only.** No one-fix-at-a-time builds.
5. Owner's non-negotiables (zero-click, editor never opens anywhere, route order Option 1 → 2 → 3-last-resort, download failure never resubmits a prompt) are in the brief and bind both agents.

## Comment formats (first line of every comment)

- `TASK (from MK)` — an assignment: scope, files, definition of done.
- `REPORT (from Partner)` / `REPORT (from MK)` — findings, evidence, links to branches/commits.
- `REVIEW (from Partner)` / `REVIEW (from MK)` — critique of a plan or branch, with file/line references.
- `CLAIM (from …)` / `RELEASE CLAIM (from …)` — file lock / lock release.
- `DECISION NEEDED (Aslam)` — the one thing only the owner can decide, in one or two lines.
- `DONE (from …)` — closes a task, naming the commit/branch that carries the work.

## First task for the Partner Muse

Post a `REPORT (from Partner)` comment on the coordination issue confirming:
1. The current route order in the code and where binding decisions are made.
2. Your adversarial review of the v2.48.45 pack scope (in the brief) — what could still waste the ZEROCLICK13 cycle.
3. Your ranked hypotheses for the `bindReason=none` problem (full-size stream, first seen in the task's own hover watch, stays unbound).
