# Workflow shapes: static and dynamic

The important distinction in Sigil is not file format. It is whether the workflow shape is known before the run or chosen during the run.

## The practical test

Ask: can you draw every stage, job, and step before the run starts?

If yes, the workflow is static. If no, the workflow is dynamic.

A static workflow can still use runtime data. The key is that runtime data only chooses among predefined paths. A dynamic workflow lets runtime data create or choose work that was not fully known at the start.

## Static workflow

A static workflow has a topology that is known before the run starts. The stages, jobs, and steps are already defined. Conditions may choose between predefined paths, but the structure itself does not grow at runtime.

```text
triage issue
  -> classify
  -> if BUG, fix
  -> if FEATURE, write spec
```

The branches are known before the run. YAML is a good fit when that fixed stage/job/step structure is the clearest representation.

Static workflows are useful for release checklists, fixed review pipelines, simple triage flows, and recurring reports with the same structure. YAML can still choose agents, run steps in parallel, write artifacts, use conditions, and run deterministic checks.

## Dynamic workflow

A dynamic workflow changes shape based on what the run discovers. Runtime results can change which work runs next, how many branches exist, which agents are chosen, whether to iterate, or which child sigils get called.

```text
research topic
  -> search sources
  -> decide which leads need follow-up
  -> create follow-up branches from findings
  -> synthesize
```

The workflow discovers its own next steps. TypeScript is the natural fit because the workflow is ordinary code: it can branch, iterate, choose agents, compose sigils, and adapt at runtime.

Dynamic workflows are useful for repository exploration where later reads depend on earlier findings, research workflows that follow sources or leads, parallel analysis followed by synthesis and follow-up investigation, and generated artifacts that need critique, repair, and validation loops.

## Same concepts, different surfaces

The same concepts can appear in both static and dynamic workflows: agents, prompt steps, parallel jobs, structured output, artifacts, deterministic checks, conditions, and nested workflow calls.

Use YAML when the fixed structure is the main value. Use TypeScript when runtime adaptation is the main value.
