# Code review before merge

After the relevant verification passes, inspect the final branch diff for
correctness, regressions, authorization, data loss and the agreed acceptance criteria.
Review in the current session. Record the reviewed revision, method, findings and
verification limits.

Fix confirmed actionable findings, rerun the affected checks and review the updated
diff. Investigate ambiguous findings using code and reproducible evidence; ask the
human only for a genuine product decision or missing authorization. Do not merge with
a confirmed unresolved defect.

Do not run Bugbot. Do not wait for Bugbot. Bugbot is not a merge gate: a missing,
pending, failed or skipped Bugbot check must not block delivery.

Merge when CI is green and required tests, verification and existing human gates
are satisfied. Mark a bug Fixed or a feature/To-Do Gata only after the actual merge
and any required deploy. Documentation-only branches still receive a proportionate
review and normal delivery. Skip review and merge only when the task changed no
files or branch state, such as a test run or data-only operation; record its
execution evidence instead. Review never replaces browser/SQL verification or the
human's UI acceptance.
