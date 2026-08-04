# Cursor Bugbot merge gate

Read this reference immediately before any code merge. It applies to every
repository branch or orchestrator worktree that contains a code diff.

## Why this gate exists

Tests prove the behavior someone expected. Cursor Bugbot examines the diff from
a fresh perspective and can find integration mistakes, regression paths and
scope leaks that the implementing agent missed. Waiting for it before merge is
cheap compared with repairing a regression after main or production has moved.

## Required sequence

1. Finish the implementation and run the relevant build, tests, and
   preview/SQL verification.
2. Launch exactly one Cursor Bugbot review against the branch/worktree diff:

   ```text
   Full Repository Path: <absolute branch or worktree path>
   Diff: branch changes
   Custom Instructions: Review this diff for correctness, regressions, security,
   data loss, and incomplete acceptance criteria. Treat unresolved findings as
   merge blockers.
   ```

3. Wait for Bugbot to finish. Never merge while it is running.
4. If Bugbot reports no actionable findings, proceed to merge.
5. If Bugbot reports actionable findings:
   - fix every confirmed finding on the same branch/worktree;
   - rerun the affected verification plus build/tests;
   - launch a fresh Bugbot review on the updated diff;
   - repeat until Bugbot has no actionable findings.
6. If a finding is ambiguous or believed incorrect, do not silently waive it.
   Park the branch and ask the human for a decision. No merge happens meanwhile.
7. If Bugbot cannot start, cannot compute the diff, times out, or fails before a
   usable verdict, do not merge. Report the blocker and preserve the branch.

## Scope

- Skip the gate only when there is no code diff to merge, such as a test-runner
  that only writes test results to the database.
- A successful Bugbot review is an additional gate; it never replaces
  preview/SQL verification, required test plans, or the human visual gate.
- Mark a Bug `Fixed` or a Feature/To-Do `Gata` only after the bugbot-clean branch
  has actually merged to main. A deploy can still be a separate required step.
