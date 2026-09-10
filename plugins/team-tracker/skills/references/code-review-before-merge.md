# Code review before merge

After the relevant verification passes, inspect the final branch diff for
correctness, regressions, authorization, data loss and the agreed acceptance criteria.
Use an independent reviewer when one is available; otherwise perform and record the
review in the current session. No named bot, external review service or extra plugin
is required. An unavailable review integration does not block delivery or require
permission to use the available review method.

Fix confirmed actionable findings, rerun the affected checks and review the updated
diff. Investigate ambiguous findings using code and reproducible evidence; ask the
human only for a genuine product decision or missing authorization. Do not merge with
a confirmed unresolved defect or while an already-started required review is running.

Record the reviewed revision, method, findings and verification limits. Never label
a manual or agent review as a result from a tool that did not run.

Merge once the review, required tests and existing human gates are satisfied. Mark a
bug Fixed or a feature/To-Do Gata only after the actual merge and any required deploy.
Documentation-only branches still receive a proportionate review and normal delivery.
Skip review and merge only when the task changed no files or branch state, such as
a test run or data-only operation; record its execution evidence instead. Review
never replaces browser/SQL verification or the human's UI acceptance.
