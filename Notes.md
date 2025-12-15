# Agentic Harness v1 — Concrete Schemas + DBOS Workflow Skeleton

This includes all 3 deliverables:

1. **`TaskGraph` JSON Schema + examples**
2. **Schemas for compaction events + memory deltas + playbook diffs**
3. **Minimal DBOS Transact TS workflow skeleton** (bounded parallelism + maintenance hooks)

It assumes:

* **Anthropic provider default**
* **Skills-first + progressive disclosure** via `SKILL.md` YAML frontmatter (`name`, `description`) preloaded at startup; full skill docs loaded only when selected. ([Anthropic][1])
* **DBOS durability** using `DBOS.registerWorkflow/registerStep` and `DBOS.runStep`, with safe parallelism using deterministic start order + `Promise.allSettled`. ([DBOS Docs][2])
* **Queue-based concurrency controls** for workflow-level throttling. ([DBOS Docs][3])

---

## 1) `TaskGraph` JSON Schema (draft 2020-12)

> This schema is designed for **DAG execution with scoped state isolation**, pointer-first artifacts, staged memory updates, and explicit acceptance criteria.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/taskgraph.schema.json",
  "title": "TaskGraph",
  "type": "object",
  "required": ["version", "runId", "objective", "nodes"],
  "properties": {
    "version": { "type": "string", "const": "1.0" },
    "runId": { "type": "string", "minLength": 8 },
    "objective": { "type": "string", "minLength": 1 },
    "constraints": {
      "type": "array",
      "items": { "$ref": "#/$defs/Constraint" },
      "default": []
    },
    "global": {
      "$ref": "#/$defs/GlobalConfig"
    },
    "nodes": {
      "type": "array",
      "minItems": 1,
      "items": { "$ref": "#/$defs/NodeSpec" }
    }
  },
  "$defs": {
    "GlobalConfig": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxParallelism": { "type": "integer", "minimum": 1, "default": 4 },
        "tokenBudget": { "type": "integer", "minimum": 1024, "default": 20000 },
        "maintenance": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "reciteEverySteps": { "type": "integer", "minimum": 1, "default": 8 },
            "reflectEveryNodes": { "type": "integer", "minimum": 1, "default": 1 },
            "compactWhenTokenUsagePct": { "type": "number", "minimum": 0.1, "maximum": 0.95, "default": 0.75 }
          }
        }
      }
    },
    "NodeSpec": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "type", "objective", "deps", "scope", "io", "acceptance"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-zA-Z0-9._-]{3,64}$" },
        "type": {
          "type": "string",
          "enum": ["plan", "research", "execute", "synthesize", "verify", "curate", "commit"]
        },
        "objective": { "type": "string", "minLength": 1 },
        "deps": {
          "type": "array",
          "items": { "type": "string", "pattern": "^[a-zA-Z0-9._-]{3,64}$" },
          "default": []
        },
        "skillHints": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        },
        "scope": { "$ref": "#/$defs/Scope" },
        "io": { "$ref": "#/$defs/IOContract" },
        "acceptance": {
          "type": "array",
          "minItems": 1,
          "items": { "$ref": "#/$defs/AcceptanceTest" }
        },
        "budgets": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "maxSteps": { "type": "integer", "minimum": 1, "default": 20 },
            "maxTokens": { "type": "integer", "minimum": 512, "default": 12000 }
          }
        },
        "retryPolicy": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "retriesAllowed": { "type": "boolean", "default": true },
            "maxAttempts": { "type": "integer", "minimum": 1, "default": 3 },
            "intervalSeconds": { "type": "integer", "minimum": 1, "default": 5 },
            "backoffRate": { "type": "number", "minimum": 1.0, "default": 2.0 }
          }
        }
      }
    },
    "Scope": {
      "type": "object",
      "additionalProperties": false,
      "required": ["artifactNamespace", "artifactPolicy", "memoryWritePolicy", "allowedSkills"],
      "properties": {
        "artifactNamespace": { "type": "string", "minLength": 1 },
        "artifactPolicy": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "allowReadsFrom": {
              "type": "array",
              "items": { "type": "string" },
              "default": []
            },
            "writeMode": { "type": "string", "enum": ["scopedOnly", "scopedPlusSharedAppend"], "default": "scopedOnly" },
            "pointerFirst": { "type": "boolean", "default": true }
          }
        },
        "memoryWritePolicy": {
          "type": "string",
          "enum": ["deny", "stageDeltaOnly", "curatorOnly"],
          "default": "stageDeltaOnly"
        },
        "sessionVisibility": {
          "type": "string",
          "enum": ["ownOnly", "ownPlusDeps", "full"],
          "default": "ownPlusDeps"
        },
        "allowedSkills": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        }
      }
    },
    "IOContract": {
      "type": "object",
      "additionalProperties": false,
      "required": ["inputs", "outputs"],
      "properties": {
        "inputs": {
          "type": "array",
          "items": { "$ref": "#/$defs/ArtifactRef" },
          "default": []
        },
        "outputs": {
          "type": "array",
          "items": { "$ref": "#/$defs/ArtifactRef" },
          "default": []
        }
      }
    },
    "ArtifactRef": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "type"],
      "properties": {
        "name": { "type": "string", "minLength": 1 },
        "type": {
          "type": "string",
          "enum": ["markdown", "json", "text", "code", "dataset", "log", "binary", "report"]
        },
        "description": { "type": "string", "default": "" }
      }
    },
    "AcceptanceTest": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "type", "criteria"],
      "properties": {
        "id": { "type": "string", "minLength": 3 },
        "type": { "type": "string", "enum": ["schema", "checks", "humanReview", "unitTests"] },
        "criteria": { "type": "string", "minLength": 1 },
        "requiresArtifacts": {
          "type": "array",
          "items": { "type": "string" },
          "default": []
        }
      }
    },
    "Constraint": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "text", "strength"],
      "properties": {
        "id": { "type": "string" },
        "text": { "type": "string" },
        "strength": { "type": "string", "enum": ["hard", "soft"], "default": "hard" }
      }
    }
  }
}
```

---

## 1b) Example `TaskGraph` — parallel research + isolated execution + single commit

```json
{
  "version": "1.0",
  "runId": "run_2025_12_14_001",
  "objective": "Produce a security posture report for repo X with evidence and prioritized actions.",
  "constraints": [
    { "id": "c1", "text": "No large tool outputs in prompt; store as artifacts and pass pointers.", "strength": "hard" },
    { "id": "c2", "text": "All memory updates must be staged and merged only at commit.", "strength": "hard" }
  ],
  "global": { "maxParallelism": 3, "tokenBudget": 20000, "maintenance": { "reciteEverySteps": 8, "reflectEveryNodes": 1, "compactWhenTokenUsagePct": 0.75 } },
  "nodes": [
    {
      "id": "plan",
      "type": "plan",
      "objective": "Plan DAG, define acceptance criteria and required artifacts.",
      "deps": [],
      "skillHints": ["planning.playbook"],
      "scope": {
        "artifactNamespace": "runs/run_2025_12_14_001/nodes/plan",
        "artifactPolicy": { "allowReadsFrom": [], "writeMode": "scopedOnly", "pointerFirst": true },
        "memoryWritePolicy": "stageDeltaOnly",
        "sessionVisibility": "ownOnly",
        "allowedSkills": ["planning.playbook", "skills.index"]
      },
      "io": { "inputs": [], "outputs": [{ "name": "taskgraph.json", "type": "json", "description": "Final DAG spec" }, { "name": "todo.md", "type": "markdown", "description": "Recitation plan" }] },
      "acceptance": [{ "id": "a1", "type": "schema", "criteria": "taskgraph.json validates against TaskGraph schema", "requiresArtifacts": ["taskgraph.json"] }]
    },
    {
      "id": "repo_inventory",
      "type": "research",
      "objective": "Inventory repo structure, languages, entrypoints; write artifact index (pointers).",
      "deps": ["plan"],
      "skillHints": ["repo_audit"],
      "scope": {
        "artifactNamespace": "runs/run_2025_12_14_001/nodes/repo_inventory",
        "artifactPolicy": { "allowReadsFrom": ["runs/run_2025_12_14_001/nodes/plan"], "writeMode": "scopedOnly", "pointerFirst": true },
        "memoryWritePolicy": "stageDeltaOnly",
        "sessionVisibility": "ownPlusDeps",
        "allowedSkills": ["repo_audit", "fs_nav"]
      },
      "io": { "inputs": [], "outputs": [{ "name": "repo_index.json", "type": "json", "description": "Indexed file map + pointers" }] },
      "acceptance": [{ "id": "a2", "type": "checks", "criteria": "repo_index.json includes top-level dirs, languages, build/test commands if found", "requiresArtifacts": ["repo_index.json"] }]
    },
    {
      "id": "dependency_risks",
      "type": "research",
      "objective": "Identify risky dependencies and configs; store raw evidence as artifacts.",
      "deps": ["plan", "repo_inventory"],
      "skillHints": ["dependency_audit"],
      "scope": {
        "artifactNamespace": "runs/run_2025_12_14_001/nodes/dependency_risks",
        "artifactPolicy": { "allowReadsFrom": ["runs/run_2025_12_14_001/nodes/repo_inventory"], "writeMode": "scopedOnly", "pointerFirst": true },
        "memoryWritePolicy": "stageDeltaOnly",
        "sessionVisibility": "ownPlusDeps",
        "allowedSkills": ["dependency_audit", "fs_nav"]
      },
      "io": { "inputs": [{ "name": "repo_index.json", "type": "json" }], "outputs": [{ "name": "dependency_findings.json", "type": "json" }, { "name": "evidence_index.json", "type": "json" }] },
      "acceptance": [{ "id": "a3", "type": "schema", "criteria": "dependency_findings.json conforms to finding schema (internal)", "requiresArtifacts": ["dependency_findings.json"] }]
    },
    {
      "id": "synthesize_report",
      "type": "synthesize",
      "objective": "Synthesize a coherent report with prioritized actions; reference evidence pointers only.",
      "deps": ["dependency_risks"],
      "skillHints": ["report_writer"],
      "scope": {
        "artifactNamespace": "runs/run_2025_12_14_001/nodes/synthesize_report",
        "artifactPolicy": { "allowReadsFrom": ["runs/run_2025_12_14_001/nodes/dependency_risks"], "writeMode": "scopedOnly", "pointerFirst": true },
        "memoryWritePolicy": "stageDeltaOnly",
        "sessionVisibility": "ownPlusDeps",
        "allowedSkills": ["report_writer"]
      },
      "io": { "inputs": [{ "name": "dependency_findings.json", "type": "json" }], "outputs": [{ "name": "report.md", "type": "markdown" }, { "name": "memory_delta.json", "type": "json" }] },
      "acceptance": [{ "id": "a4", "type": "checks", "criteria": "report.md includes executive summary, findings, remediation, and evidence pointers", "requiresArtifacts": ["report.md"] }]
    },
    {
      "id": "commit",
      "type": "commit",
      "objective": "Apply staged memory deltas and finalize run.",
      "deps": ["synthesize_report"],
      "skillHints": ["curation.commit"],
      "scope": {
        "artifactNamespace": "runs/run_2025_12_14_001/nodes/commit",
        "artifactPolicy": { "allowReadsFrom": ["runs/run_2025_12_14_001/nodes/synthesize_report"], "writeMode": "scopedOnly", "pointerFirst": true },
        "memoryWritePolicy": "curatorOnly",
        "sessionVisibility": "ownPlusDeps",
        "allowedSkills": ["curation.commit"]
      },
      "io": { "inputs": [{ "name": "memory_delta.json", "type": "json" }], "outputs": [{ "name": "final.json", "type": "json" }] },
      "acceptance": [{ "id": "a5", "type": "checks", "criteria": "MemoryStore updated only via commit; final.json includes artifact handles and status=complete", "requiresArtifacts": ["final.json"] }]
    }
  ]
}
```

---

## 2) Schemas: Compaction Event + Memory Delta + Playbook Diff

### 2a) `CompactionEvent` JSON Schema (schema-driven, pointer-first, reversible)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/compactionevent.schema.json",
  "title": "CompactionEvent",
  "type": "object",
  "required": ["runId", "span", "summary", "artifactsIndex", "createdAt"],
  "properties": {
    "runId": { "type": "string" },
    "nodeId": { "type": "string" },
    "span": {
      "type": "object",
      "required": ["fromEventId", "toEventId"],
      "properties": {
        "fromEventId": { "type": "string" },
        "toEventId": { "type": "string" }
      }
    },
    "summary": {
      "type": "object",
      "required": ["goal", "decisions", "constraints", "openQuestions", "nextActions"],
      "properties": {
        "goal": { "type": "string" },
        "decisions": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["decision", "reason"],
            "properties": {
              "decision": { "type": "string" },
              "reason": { "type": "string" },
              "evidenceRefs": { "type": "array", "items": { "type": "string" }, "default": [] }
            }
          }
        },
        "constraints": {
          "type": "array",
          "items": { "type": "object", "required": ["text", "strength"], "properties": { "text": { "type": "string" }, "strength": { "type": "string", "enum": ["hard", "soft"] } } },
          "default": []
        },
        "openQuestions": { "type": "array", "items": { "type": "string" }, "default": [] },
        "nextActions": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
        "failuresSoFar": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["symptom", "resolutionStatus"],
            "properties": {
              "symptom": { "type": "string" },
              "resolutionStatus": { "type": "string", "enum": ["open", "mitigated", "resolved"] },
              "evidenceRefs": { "type": "array", "items": { "type": "string" }, "default": [] }
            }
          },
          "default": []
        }
      }
    },
    "artifactsIndex": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "handle", "shortSummary"],
        "properties": {
          "name": { "type": "string" },
          "handle": { "type": "string" },
          "shortSummary": { "type": "string" },
          "tags": { "type": "array", "items": { "type": "string" }, "default": [] }
        }
      }
    },
    "createdAt": { "type": "string", "format": "date-time" }
  }
}
```

### 2b) `MemoryDelta` JSON Schema (staged updates only; commit merges)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/memorydelta.schema.json",
  "title": "MemoryDelta",
  "type": "object",
  "required": ["runId", "nodeId", "adds", "createdAt"],
  "properties": {
    "runId": { "type": "string" },
    "nodeId": { "type": "string" },
    "adds": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "facts": { "type": "array", "items": { "$ref": "#/$defs/MemoryItem" }, "default": [] },
        "constraints": { "type": "array", "items": { "$ref": "#/$defs/MemoryItem" }, "default": [] },
        "preferences": { "type": "array", "items": { "$ref": "#/$defs/MemoryItem" }, "default": [] },
        "tactics": { "type": "array", "items": { "$ref": "#/$defs/MemoryItem" }, "default": [] },
        "pitfalls": { "type": "array", "items": { "$ref": "#/$defs/MemoryItem" }, "default": [] }
      },
      "required": ["facts", "constraints", "preferences", "tactics", "pitfalls"]
    },
    "createdAt": { "type": "string", "format": "date-time" }
  },
  "$defs": {
    "MemoryItem": {
      "type": "object",
      "required": ["id", "text", "evidenceRefs", "confidence"],
      "properties": {
        "id": { "type": "string" },
        "text": { "type": "string" },
        "evidenceRefs": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    }
  }
}
```

### 2c) `PlaybookDiff` JSON Schema (ACE-style typed diffs, auditable and reversible)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/playbookdiff.schema.json",
  "title": "PlaybookDiff",
  "type": "object",
  "required": ["runId", "nodeId", "ops", "createdAt"],
  "properties": {
    "runId": { "type": "string" },
    "nodeId": { "type": "string" },
    "ops": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["op", "targetFile", "reason", "evidenceRefs"],
        "properties": {
          "op": { "type": "string", "enum": ["ADD_BULLET", "REMOVE_BULLET", "EDIT_BULLET"] },
          "targetFile": { "type": "string", "enum": ["playbook.md", "pitfalls.md", "policies.md"] },
          "bulletId": { "type": "string" },
          "before": { "type": "string" },
          "after": { "type": "string" },
          "reason": { "type": "string" },
          "evidenceRefs": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1, "default": 0.7 }
        }
      }
    },
    "createdAt": { "type": "string", "format": "date-time" }
  }
}
```

---

## 3) Minimal DBOS Workflow Skeleton (TypeScript)

This skeleton uses:

* `DBOS.registerWorkflow` / `DBOS.runStep` for durability and retries. ([DBOS Docs][2])
* `Promise.allSettled` with **deterministic step start order** for safe parallel steps. ([DBOS Docs][4])
* `WorkflowQueue` for workflow-level concurrency control. ([DBOS Docs][3])
* Skills progressive disclosure pattern (metadata preload + full load on demand). ([Anthropic][1])

> Note: You can swap to decorators (`@DBOS.workflow()`, `@DBOS.step()`) if you prefer; the concepts are the same.

```ts
import { DBOS, WorkflowQueue } from "@dbos-inc/dbos-sdk";

// --- Queue-level throttling for whole runs (across processes) ---
export const runQueue = new WorkflowQueue("agent_runs", {
  workerConcurrency: 3, // per-process
  // concurrency: 10, // optional global cap
}); // :contentReference[oaicite:7]{index=7}

// -------------------------
// Types (align with schemas)
// -------------------------
type RunSpec = {
  runId: string;
  objective: string;
  input?: Record<string, unknown>;
};

type TaskGraph = {
  version: "1.0";
  runId: string;
  objective: string;
  global?: { maxParallelism?: number; maintenance?: { reciteEverySteps?: number; reflectEveryNodes?: number; compactWhenTokenUsagePct?: number } };
  nodes: NodeSpec[];
};

type NodeSpec = {
  id: string;
  type: "plan" | "research" | "execute" | "synthesize" | "verify" | "curate" | "commit";
  objective: string;
  deps: string[];
  scope: {
    artifactNamespace: string;
    memoryWritePolicy: "deny" | "stageDeltaOnly" | "curatorOnly";
    allowedSkills: string[];
  };
  budgets?: { maxSteps?: number; maxTokens?: number };
  retryPolicy?: { retriesAllowed?: boolean; maxAttempts?: number; intervalSeconds?: number; backoffRate?: number };
};

type RunResult = {
  runId: string;
  status: "complete" | "failed";
  outputs: { name: string; handle: string }[];
};

// -------------------------
// Stores (interfaces only)
// -------------------------
interface ArtifactStore {
  putText(path: string, content: string): Promise<string>; // returns handle
  putJson(path: string, obj: unknown): Promise<string>;
  getText(handle: string): Promise<string>;
}

interface SessionStore {
  appendEvent(e: { runId: string; nodeId?: string; type: string; refs?: string[]; payload?: unknown }): Promise<void>;
}

interface MemoryStore {
  retrieve(query: string, opts: { runId: string; nodeId: string; k: number }): Promise<Array<{ id: string; text: string; evidenceRefs: string[] }>>;
  applyMemoryDelta(deltaHandle: string): Promise<void>;
  applyPlaybookDiff(diffHandle: string): Promise<void>;
}

// -------------------------
// Skill system (skeleton)
// -------------------------
type SkillMeta = { id: string; name: string; description: string; tags?: string[] };
interface SkillRegistry {
  listMetadata(): Promise<SkillMeta[]>; // preload name+description only
  loadSkillMarkdown(skillId: string): Promise<string>; // full SKILL.md on demand
}
// Skills progressive disclosure: metadata at startup; full SKILL.md only when selected. :contentReference[oaicite:8]{index=8}

// -------------------------
// Context compiler (skeleton)
// -------------------------
type CompiledContext = { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> };
interface ContextCompiler {
  compile(args: {
    run: RunSpec;
    node: NodeSpec;
    skillIndex: SkillMeta[];
    loadedSkills: string[]; // raw markdown blocks
    memoryHits: Array<{ id: string; text: string; evidenceRefs: string[] }>;
    artifactPointers: Array<{ name: string; handle: string; shortSummary: string }>;
    todoMarkdown: string;
  }): Promise<CompiledContext>;
}

interface LLMProvider {
  complete(ctx: CompiledContext, opts: { maxTokens: number }): Promise<string>;
}

// -------------------------
// Main workflow registration
// -------------------------
async function runDAGWorkflow(run: RunSpec): Promise<RunResult> {
  // 1) plan graph (durable step)
  const graph = await DBOS.runStep(
    async () => planGraph(run),
    { name: "planGraph", retriesAllowed: true, maxAttempts: 2, intervalSeconds: 2, backoffRate: 2.0 }
  ); // :contentReference[oaicite:9]{index=9}

  // 2) execute graph (durable step wrapper)
  const result = await DBOS.runStep(
    async () => executeGraph(run, graph),
    { name: "executeGraph", retriesAllowed: true, maxAttempts: 2, intervalSeconds: 2, backoffRate: 2.0 }
  ); // :contentReference[oaicite:10]{index=10}

  return result;
}

export const runDAG = DBOS.registerWorkflow(runDAGWorkflow, { name: "runDAG" }); // :contentReference[oaicite:11]{index=11}

// -------------------------
// Planning step
// -------------------------
async function planGraph(run: RunSpec): Promise<TaskGraph> {
  // In practice:
  // - load skill metadata index (cheap)
  // - compile minimal planning context
  // - call Anthropic to propose DAG (nodes/deps/scopes/acceptance)
  // - write todo.md (recitation anchor)
  // - persist TaskGraph as an artifact and record session event

  // Placeholder:
  return {
    version: "1.0",
    runId: run.runId,
    objective: run.objective,
    global: { maxParallelism: 3, maintenance: { reciteEverySteps: 8, reflectEveryNodes: 1, compactWhenTokenUsagePct: 0.75 } },
    nodes: [
      { id: "plan", type: "plan", objective: "Plan DAG", deps: [], scope: { artifactNamespace: `runs/${run.runId}/nodes/plan`, memoryWritePolicy: "stageDeltaOnly", allowedSkills: ["planning.playbook"] } },
      { id: "commit", type: "commit", objective: "Finalize", deps: ["plan"], scope: { artifactNamespace: `runs/${run.runId}/nodes/commit`, memoryWritePolicy: "curatorOnly", allowedSkills: ["curation.commit"] } }
    ]
  };
}

// -------------------------
// Execution engine (bounded parallelism + maintenance hooks)
// -------------------------
async function executeGraph(run: RunSpec, graph: TaskGraph): Promise<RunResult> {
  const maxPar = graph.global?.maxParallelism ?? 3;
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  const completed = new Set<string>();
  const failed = new Set<string>();

  // simplistic: until all nodes complete
  while (completed.size + failed.size < graph.nodes.length) {
    // ready nodes: deps satisfied and not yet done
    const ready = graph.nodes
      .filter(n => !completed.has(n.id) && !failed.has(n.id))
      .filter(n => n.deps.every(d => completed.has(d)));

    if (ready.length === 0) {
      throw new Error(`Deadlock: no ready nodes but graph incomplete. completed=${[...completed].join(",")}`);
    }

    // deterministic start order required for DBOS parallel steps :contentReference[oaicite:12]{index=12}
    const readySorted = [...ready].sort((a, b) => a.id.localeCompare(b.id));

    // bounded concurrency by batching deterministically
    for (let i = 0; i < readySorted.length; i += maxPar) {
      const batch = readySorted.slice(i, i + maxPar);

      // --- maintenance hook: recite todo every N steps (example) ---
      await DBOS.runStep(() => maintenanceRecite(run, graph, { reason: "batch_start" }), { name: `recite_${completed.size}_${i}` });

      // Start node steps in deterministic order then await allSettled :contentReference[oaicite:13]{index=13}
      const promises = batch.map((node) =>
        DBOS.runStep(
          () => executeNode(run, graph, node),
          {
            name: `node_${node.id}`,
            ...(node.retryPolicy ?? {}),
          }
        )
      );

      const results = await Promise.allSettled(promises); // prefer allSettled :contentReference[oaicite:14]{index=14}

      for (let j = 0; j < results.length; j++) {
        const node = batch[j];
        const r = results[j];
        if (r.status === "fulfilled") {
          completed.add(node.id);

          // maintenance: reflect/curate after each node (example)
          await DBOS.runStep(() => maintenanceReflectAndCurate(run, graph, node), { name: `reflect_curate_${node.id}` });

        } else {
          failed.add(node.id);
          // Keep wrong turns: store error artifact + session event (inside executeNode ideally)
        }
      }

      // if any failures, you can either:
      // - continue running independent nodes
      // - or early abort depending on policy
      if (failed.size > 0) {
        // conservative: abort run
        throw new Error(`Node failures: ${[...failed].join(", ")}`);
      }
    }
  }

  // commit step (merge memory deltas + playbook diffs)
  const commitNode = nodeMap.get("commit");
  if (commitNode) {
    await DBOS.runStep(() => executeNode(run, graph, commitNode), { name: "node_commit" });
  }

  return {
    runId: run.runId,
    status: "complete",
    outputs: [
      { name: "final", handle: `runs/${run.runId}/nodes/commit/final.json` }
    ]
  };
}

// -------------------------
// Node execution (compiled context + pointer-first + staged memory)
// -------------------------
async function executeNode(run: RunSpec, graph: TaskGraph, node: NodeSpec): Promise<void> {
  // Pseudocode (what this step should do):
  // 1) Build WorkingContext via ContextCompiler:
  //    - stable prefix (cacheable)
  //    - current node objective + acceptance
  //    - todo.md (recitation)
  //    - memory retrieval hits (ranked, small)
  //    - artifact pointers (no raw blobs)
  //    - skill metadata index; load full skill docs only if selected
  //
  // 2) Call Anthropic provider with compiled context
  // 3) Write outputs to ArtifactStore (pointer-first)
  // 4) Append events to SessionStore (including compaction events if needed)
  // 5) Emit MemoryDelta/PlaybookDiff as artifacts (but do NOT apply unless commit/curator)

  // Important: DBOS may retry steps on failure; prefer idempotent writes (content-hash paths)
  // Step config includes retries options in DBOS docs. :contentReference[oaicite:15]{index=15}
}

// -------------------------
// Maintenance hooks (recite / compact / reflect / curate)
// -------------------------
async function maintenanceRecite(run: RunSpec, graph: TaskGraph, args: { reason: string }): Promise<void> {
  // Rewrite todo.md so the “Goal / Next actions / Open questions” stays fresh and appears at end of context.
  // Store as artifact and log a SessionStore event.
}

async function maintenanceReflectAndCurate(run: RunSpec, graph: TaskGraph, node: NodeSpec): Promise<void> {
  // Reflect: produce structured reflection artifact
  // Curate: produce typed diffs (PlaybookDiff) + staged MemoryDelta artifacts
  // Do not apply; only commit/curator node applies.
}

// -------------------------
// Launching a run (e.g., from API)
// -------------------------
export async function startRun(run: RunSpec) {
  // Start workflow on a queue (managed concurrency) :contentReference[oaicite:16]{index=16}
  // Example pattern from DBOS docs: DBOS.startWorkflow(Class, {queueName}).method(args) :contentReference[oaicite:17]{index=17}

  // If using registerWorkflow (function style), the exact start API depends on your app setup.
  // Common approach is using DBOS.startWorkflow with a workflow method; adapt to your registration style.
}
```

### Notes you’ll actually care about

* **Parallel steps**: DBOS explicitly calls out that `Promise.allSettled([step1(), step2(), ...])` is valid if the steps are started in a deterministic order. ([DBOS Docs][4])
* **Retries**: `DBOS.runStep` supports retry settings like `maxAttempts`, `intervalSeconds`, `backoffRate`. ([DBOS Docs][2])
* **Queue throttling**: `WorkflowQueue(... { workerConcurrency })` limits concurrent workflows per process; optional global caps exist too. ([DBOS Docs][3])
* **Skills**: preload only skill metadata (`name`, `description`) into the system prompt, load full `SKILL.md` only when needed. ([Anthropic][1])

---

## Optional: a tiny `SKILL.md` template (skills-first + progressive disclosure)

```md
---
name: repo_audit
description: Audit a source repo by indexing files, extracting build/test commands, and producing pointer-first evidence artifacts.
---

## When to use
- When asked to analyze a repo or produce findings with evidence.

## Inputs (artifact handles)
- repo path or repo_index.json

## Outputs (artifact handles)
- repo_index.json
- findings.json
- evidence_index.json

## Procedure (pointer-first)
1. Never paste large logs; write them to artifacts and reference handles.
2. Use filesystem navigation to sample only relevant files.
3. Keep a running todo.md with next actions and open questions.
```

This matches the requirement that skills are directories with `SKILL.md` starting with YAML frontmatter, and that metadata is preloaded while full contents are loaded on demand. ([Anthropic][1])

---

If you want the “next layer down,” tell me what your artifact store is (local FS vs S3) and what DB you’re using for Postgres, and I’ll wire the skeleton into a concrete module set (`ArtifactStore`, `SessionStore`, `MemoryStore`, `SkillRegistry`, `ContextCompiler`) with real method bodies and file paths.

[1]: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills "Equipping agents for the real world with Agent Skills \ Anthropic"
[2]: https://docs.dbos.dev/typescript/reference/workflows-steps "Workflows & Steps | DBOS Docs"
[3]: https://docs.dbos.dev/typescript/tutorials/queue-tutorial "Queues & Concurrency | DBOS Docs"
[4]: https://docs.dbos.dev/typescript/tutorials/workflow-tutorial "Workflows | DBOS Docs"
