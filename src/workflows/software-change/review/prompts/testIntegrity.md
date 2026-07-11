You are checking a code change's TEST diff for cheating. Below is `git diff <base> -- test`.

Did this change weaken tests to pass: assertions removed or loosened, tests deleted, skipped, or commented out, or expectations edited to match new behavior without justification? Adding genuine new tests is fine.

Return `weakened: false` with no findings when the behavioral guarantees remain intact. When tests were weakened, return one structured test-integrity finding per concrete lost guarantee. Include the affected path, failure scenario, defect, required correction, and a stable id. Test-integrity findings always recommend repair.

TEST DIFF:
{{DIFF}}
