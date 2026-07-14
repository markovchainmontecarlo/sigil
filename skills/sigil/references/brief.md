# Brief reference

Write one `brief.md` for planning or implementation. Show the complete document to the developer and wait for confirmation or correction before execution.

## Intent

State the outcome the developer wants and why it matters.

## Acceptance criteria

List observable outcomes that prove the change is complete.

## Decisions

Record product, behavior, and architecture choices that planning and implementation must preserve.

## Architecture

Describe the desired dependency direction, ownership boundary, or state flow when the accepted change requires one.

## Repository context

Record stable facts established from source or observed behavior. Name relevant files and symbols without treating them as a restrictive allowlist.

## Claims to verify

Record uncertain descriptions of current behavior, dependencies, or feasibility that agents must check before relying on them.

## Constraints

State protected behavior, resources, authority limits, and other boundaries.

## Non-goals

State work that must not be introduced.

## References

List the complete plan, task graph, source files, design documents, or runtime evidence that shape the change.

## Storage and authority

Store the brief beneath the ignored `<repo>/.sigil/runs/` directory. Do not track it.

Intent, acceptance criteria, decisions, architecture, constraints, and non-goals are confirmed inputs when they record choices the developer accepted. Repository context and claims to verify remain subject to current source and observed behavior. References are supporting material unless the brief explicitly assigns them stronger authority.

Repository evidence may correct descriptions of the current system, feasibility claims, affected-file expectations, and proposed mechanisms. It does not independently authorize changing the confirmed outcome or accepted boundaries. Report an infeasible or internally inconsistent confirmed input instead of silently rewriting it.

Only record a desired architecture under Architecture after the developer accepts it. Describe the current architecture under Repository context, and place a proposed or uncertain architecture under Claims to verify.
