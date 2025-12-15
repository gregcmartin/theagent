# Agentic Harness Framework (TypeScript) — Memory-First, Context-Compiled, Skills-First, DAG + Durable Workflows

This is the rewritten harness architecture that **bakes in**: Google ADK-style **tiered memory + context compiler**, Anthropic **compaction + note-taking + minimal interfaces**, Manus **pointer-first offloading + recitation**, and ACE/Dynamic-Cheatsheet **self-improving context artifacts via diff updates**, while still keeping: **DAG orchestration**, **parallel sub-agents with isolation**, **Anthropic default provider**, **skills wherever possible**, and **DBOS durable workflows**.

---

## Goals

* **Finish long-running tasks successfully** (hours+), even across crashes/restarts.
* **High signal / low token** execution (avoid context bloat).
* **Parallel DAG execution** with strict **state isolation** and controlled merges.
* **Skills-first runtime** (procedural knowledge lives in skills directories; loaded progressively).
* **Self-improving runs** via **Reflect → Curate → Diff-apply** (no fine-tuning required).

---

## Design axioms (non-negotiables)

1. **Default working context is nearly empty.** Everything else is retrieved or referenced on demand.
2. **Context is compiled** each step from durable state (not appended transcripts).
3. **Pointer-first artifacts**: large objects live outside prompts; inject handles + summaries.
4. **Tiered memory**: Working Context ⟂ Session Log ⟂ Curated Memory ⟂ Artifacts.
5. **Compaction is a first-class event** (reversible via pointers).
6. **Recitation is always-on**: `todo.md / plan.md` is continuously rewritten to keep goals at the end of context.
7. **Self-improvement is deliberate**: strategy updates are typed diffs, gated, audited, and reversible.
8. **Parallel agents never share mutable state** directly; they communicate through structured artifacts and reducers.
9. **Durability by default**: every DAG node is a durable workflow step.

---

## High-level architecture

```mermaid
flowchart TB
  UI[CLI / API] --> ORCH[Orchestrator]
  ORCH --> WF[DBOS Workflow: runDAG(runSpec)]

  WF --> PLAN[Planner (Graph Builder)]
  WF --> EXEC[Graph Executor (Parallel)]
  WF --> MAINT[Maintenance Loop\n(compact/recite/reflect/curate)]
  WF --> COMMIT[Commit & Merge Gate]

  subgraph Tiered State
    SLOG[(SessionStore\nappend-only events + compaction events)]
    MEM[(MemoryStore\ncurated + retrievable)]
    ART[(ArtifactStore\npointer-first blobs/files)]
    PB[(PlaybookStore\ncheatsheet/pitfalls\n(diff-updated))]
  end

  subgraph Context System
    CC[ContextCompiler\n(processor pipeline)]
    SEL[Selectors\n(scoped retrieval)]
    SUM[Schema Summarizers\n(reversible compaction)]
  end

  subgraph Skills
    SR[Skill Registry\n(metadata preload)]
    SL[Skill Loader\n(progressive load)]
    SD[(skills/*/SKILL.md + scripts)]
  end

  subgraph LLM
    AP[Anthropic Provider (default)]
  end

  PLAN --> SR --> SL --> SD
  PLAN --> CC --> AP

  EXEC --> CC --> AP
  EXEC --> ART
  EXEC --> SLOG
  EXEC --> MEM
  EXEC --> PB

  MAINT --> SLOG
  MAINT --> ART
  MAINT --> PB
  MAINT --> MEM

  COMMIT --> MEM
  COMMIT --> PB
  COMMIT --> SLOG
```

---

## Runtime model (tiered memory + compiled context)

### Stores (durable)

**SessionStore (append-only)**

* Events: `{runId, nodeId, stepId, type, ts, refs[]}`
* Includes **compaction events** (summaries that replace/prune older spans)

**ArtifactStore (pointer-first)**

* Large tool outputs, web pages, PDFs, logs, code diffs, dataset slices, etc.
* Everything stored as:

  * `ArtifactHandle { uri/path, contentHash, type, tags, shortSummary }`

**MemoryStore (retrievable)**

* Long-lived, searchable “insights” (constraints, facts, preferences, verified outcomes)
* Vector/keyword/hybrid retrieval is allowed — but **nothing is pinned by default**

**PlaybookStore (self-improving strategy)**

* `playbook.md` (tactics that worked)
* `pitfalls.md` (failure modes)
* `policies.md` (guardrails)
* Updated only via **typed diffs** from Curator (ACE/Dynamic Cheatsheet style)

---

## Execution flow (DAG + durability + memory loops)

### 1) Orchestrator → DBOS workflow

Top-level DBOS workflow: `runDAG(runSpec)`

* persists: run metadata, DAG, node status, artifacts, events
* resumes after failure without redoing completed nodes

### 2) Planner node (build the DAG)

**Output:** `TaskGraph` artifact + initial `todo.md / plan.md`

* DAG nodes include objective, deps, acceptance tests, scope rules, and output artifact contracts

### 3) Graph Executor (parallel)

Executes ready nodes concurrently (bounded concurrency).
Each node is executed in a **node scope** with **no shared mutable state**.

### 4) Maintenance loop (always-on)

Runs at defined triggers:

* every N steps (recitation)
* on context pressure (compaction)
* on task boundary (reflect + curate)
* on errors (log + preserve failure context)

### 5) Commit & merge gate

Only commit nodes can:

* merge MemoryDeltas into MemoryStore
* apply Playbook diffs
* mark outputs as “final / verified”

---

## Node scope model (prevents clobbering in parallel)

Each DAG node runs with:

### Scoped working directory

`runs/{runId}/nodes/{nodeId}/...`

### Scoped session view

* Node reads:

  * its own recent events
  * upstream node outputs by artifact handle
* Node writes:

  * events to SessionStore
  * artifacts to its namespace only

### Staged memory writes (never direct)

Nodes produce `MemoryDelta` artifacts:

* `facts.add[]`, `constraints.add[]`, `prefs.add[]`
* `pitfalls.add[]`, `tactics.add[]`
  Only Commit/Curator merges them.

### Deterministic merge reducers

* `mergeFactsDelta()`, `mergeConstraintsDelta()`, `mergePlaybookDelta()`
* last-write-wins is forbidden; merges are typed and auditable

---

## ContextCompiler (ADK-style processor pipeline)

Every LLM call is built from a **fresh compiled view**:

```text
WorkingContext = compile(
  StablePrefix,
  NodeHeader,
  ScopedStateSlice,
  SkillMetadataIndex,
  LoadedSkillDocs,
  ArtifactPointers,
  LatestObservations
)
```

### Processor pipeline (extensible)

1. **PrefixProcessor**

   * stable identity, rules, output schemas (cache-friendly)
2. **ScopeProcessor**

   * inject only node objective + acceptance criteria + current plan/todo
3. **RecitationProcessor**

   * ensures `todo.md` + “Next actions” appear at the end of context
4. **RetrievalProcessor**

   * queries MemoryStore and SessionStore with relevance filters
   * returns *ranked* structured hits (not raw history)
5. **ArtifactPointerProcessor**

   * inject `{handle, shortSummary, tags}` not contents
6. **SkillIndexProcessor**

   * inject only `{skillName, description, tags}` for all skills
7. **SkillLoadProcessor**

   * loads full `SKILL.md` only for selected skills
8. **CompactionGuardProcessor**

   * if token budget risk: request `COMPACT()` step before proceeding

---

## Compaction (Anthropic + ADK compaction events)

Compaction is not “summarize everything.” It is **schema-driven** and **reversible**.

### Compaction event schema

* `Goal`
* `DecisionsMade[]` (with reasons)
* `Constraints[]` (hard vs soft)
* `OpenQuestions[]`
* `CurrentPlan` (next 3–7 actions)
* `ArtifactsIndex[]` (pointers to raw details)
* `FailuresSoFar[]` (kept, not erased)

**Result:** store compaction summary into SessionStore as a **compaction event**, and drop older low-value spans from future working contexts. Raw history remains accessible via artifacts.

---

## Recitation loop (Manus-style)

Every N steps (or after plan changes), rewrite `todo.md`:

**`todo.md` format**

* Goal
* Subgoals
* Next actions (ordered)
* Done
* Open questions / blockers
* “What to avoid” (pitfalls excerpt)

This keeps attention anchored and reduces “lost-in-the-middle.”

---

## Offloading heavy state (pointer-first)

Rules:

* Never inject raw multi-KB tool output by default.
* Tool outputs are written to artifacts and only reloaded if explicitly required.
* Agents operate over artifacts using skills/scripts (grep/head/tail/slicing), not by pasting blobs into the prompt.

---

## Self-improvement loop (ACE + Dynamic Cheatsheet)

After each node (or at task milestones):

### Reflect step

Produces a structured reflection artifact:

* what worked
* what failed (include wrong turns)
* what to do next time
* missing info / brittle assumptions

### Curate step

Produces **typed diffs** against:

* `playbook.md`
* `pitfalls.md`
* `policies.md`
* `memory.jsonl`

**Diff types**

* `ADD_BULLET`, `REMOVE_BULLET`, `EDIT_BULLET`
* each diff includes `reason`, `evidenceRefs[]`, `confidence`

### Apply gate

Only Curator/Commit can apply diffs.
Rules:

* max diff size per run (prevents runaway drift)
* required evidence refs for new “facts”
* rollbacks supported by storing diff history

---

## Skills-first system (Anthropic Skills integration)

We keep “tools” minimal and implement domain logic as skills.

### Skill loading strategy (progressive disclosure)

* preload only metadata for all skills into prompt
* load full SKILL.md for selected skills only
* skills can include scripts/resources that operate on artifacts

### Skills vs tools policy

* Tools: filesystem primitives + http fetch + sandbox exec (orthogonal)
* Skills: everything else (procedures, checklists, templates, parsing workflows, domain playbooks)

---

## Durable workflows with DBOS (long-running success)

### Workflow structure

* `runDAG()` workflow
* `executeNode(nodeId)` steps
* `maintenance()` steps (recite/compact/reflect/curate)
* `commit()` step (merge + finalize)

### Why this matters

* Node completion is checkpointed
* Retries happen safely
* A crash mid-run resumes without losing state or repeating completed work

---

## Data contracts (strong typing keeps agents honest)

### TaskGraph (conceptual)

* `nodes[]: { id, deps[], objective, acceptanceTests[], scope, outputs[] }`
* `scope: { artifactNamespace, memoryWritePolicy, allowedSkills[], tokenBudget }`

### ArtifactHandle

* `uri/path`, `hash`, `type`, `tags[]`, `shortSummary`

### MemoryDelta

* `facts.add[]`, `constraints.add[]`, `preferences.add[]`
* `pitfalls.add[]`, `tactics.add[]`
* each entry references evidence artifacts

### PlaybookDiff

* typed operations with evidence and reason

---

## Suggested repo layout (TypeScript)

```text
packages/
  core/
    orchestrator/
    dag/
      TaskGraph.ts
      GraphPlanner.ts
      GraphExecutor.ts
      Scope.ts
    context/
      ContextCompiler.ts
      processors/
        PrefixProcessor.ts
        ScopeProcessor.ts
        RecitationProcessor.ts
        RetrievalProcessor.ts
        ArtifactPointerProcessor.ts
        SkillIndexProcessor.ts
        SkillLoadProcessor.ts
        CompactionGuardProcessor.ts
    memory/
      SessionStore.ts
      MemoryStore.ts
      PlaybookStore.ts
      ArtifactStore.ts
      reducers/
        mergeMemoryDelta.ts
        applyPlaybookDiff.ts
    maintenance/
      Compact.ts
      ReciteTodo.ts
      Reflect.ts
      Curate.ts
  providers/
    anthropic/
      AnthropicProvider.ts
  skills/
    SkillRegistry.ts
    SkillLoader.ts
  workflows/
    dbos/
      RunDAGWorkflow.ts
      NodeSteps.ts
      MaintenanceSteps.ts
skills/
  ...
```

---

## What makes this harness “high quality” for long runs

* **Token discipline**: compiled context + pointer-first artifacts prevents attention dilution.
* **Continuity**: recitation + notes keep the agent oriented.
* **Recoverability**: DBOS workflow durability ensures progress survives failure.
* **Correctness**: acceptance tests + verifier nodes + retained failure traces reduce repeated mistakes.
* **Learning**: curated diffs improve the agent’s playbook and memory without drifting into vagueness.

---

If you want the next step, I can turn this into:

* a concrete `TaskGraph` JSON schema + examples,
* the exact schema for compaction events + memory deltas + playbook diffs,
* and a minimal DBOS workflow skeleton that executes a DAG with bounded parallelism and these maintenance hooks.
