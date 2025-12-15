/**
 * Core Types for Agentic Harness Framework
 * 
 * These types define the contracts for:
 * - TaskGraph (DAG orchestration)
 * - Compaction Events
 * - Memory Deltas
 * - Playbook Diffs
 * - Artifact Handles
 * - Run specifications
 */

import { z } from 'zod';

// ============================================================================
// CONSTRAINT TYPES
// ============================================================================

export const ConstraintSchema = z.object({
  id: z.string(),
  text: z.string(),
  strength: z.enum(['hard', 'soft']).default('hard'),
});

export type Constraint = z.infer<typeof ConstraintSchema>;

// ============================================================================
// ARTIFACT TYPES
// ============================================================================

export const ArtifactRefSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['markdown', 'json', 'text', 'code', 'dataset', 'log', 'binary', 'report']),
  description: z.string().default(''),
});

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ArtifactHandleSchema = z.object({
  uri: z.string(),
  contentHash: z.string(),
  type: z.string(),
  tags: z.array(z.string()).default([]),
  shortSummary: z.string(),
});

export type ArtifactHandle = z.infer<typeof ArtifactHandleSchema>;

// ============================================================================
// ACCEPTANCE TEST TYPES
// ============================================================================

export const AcceptanceTestSchema = z.object({
  id: z.string().min(3),
  type: z.enum(['schema', 'checks', 'humanReview', 'unitTests']),
  criteria: z.string().min(1),
  requiresArtifacts: z.array(z.string()).default([]),
});

export type AcceptanceTest = z.infer<typeof AcceptanceTestSchema>;

// ============================================================================
// SCOPE TYPES (Node isolation)
// ============================================================================

export const ArtifactPolicySchema = z.object({
  allowReadsFrom: z.array(z.string()).default([]),
  writeMode: z.enum(['scopedOnly', 'scopedPlusSharedAppend']).default('scopedOnly'),
  pointerFirst: z.boolean().default(true),
});

export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;

export const ScopeSchema = z.object({
  artifactNamespace: z.string().min(1),
  artifactPolicy: ArtifactPolicySchema.default({}),
  memoryWritePolicy: z.enum(['deny', 'stageDeltaOnly', 'curatorOnly']).default('stageDeltaOnly'),
  sessionVisibility: z.enum(['ownOnly', 'ownPlusDeps', 'full']).default('ownPlusDeps'),
  allowedSkills: z.array(z.string()).default([]),
});

export type Scope = z.infer<typeof ScopeSchema>;

// ============================================================================
// IO CONTRACT TYPES
// ============================================================================

export const IOContractSchema = z.object({
  inputs: z.array(ArtifactRefSchema).default([]),
  outputs: z.array(ArtifactRefSchema).default([]),
});

export type IOContract = z.infer<typeof IOContractSchema>;

// ============================================================================
// RETRY POLICY TYPES
// ============================================================================

export const RetryPolicySchema = z.object({
  retriesAllowed: z.boolean().default(true),
  maxAttempts: z.number().min(1).default(3),
  intervalSeconds: z.number().min(1).default(5),
  backoffRate: z.number().min(1.0).default(2.0),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

// ============================================================================
// BUDGET TYPES
// ============================================================================

export const BudgetsSchema = z.object({
  maxSteps: z.number().min(1).default(20),
  maxTokens: z.number().min(512).default(12000),
});

export type Budgets = z.infer<typeof BudgetsSchema>;

// ============================================================================
// NODE SPEC TYPES
// ============================================================================

export const NodeTypeSchema = z.enum([
  'plan',
  'research',
  'execute',
  'synthesize',
  'verify',
  'curate',
  'commit'
]);

export type NodeType = z.infer<typeof NodeTypeSchema>;

export const NodeSpecSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/),
  type: NodeTypeSchema,
  objective: z.string().min(1),
  deps: z.array(z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/)).default([]),
  skillHints: z.array(z.string()).default([]),
  scope: ScopeSchema,
  io: IOContractSchema,
  acceptance: z.array(AcceptanceTestSchema).min(1),
  budgets: BudgetsSchema.optional(),
  retryPolicy: RetryPolicySchema.optional(),
});

export type NodeSpec = z.infer<typeof NodeSpecSchema>;

// ============================================================================
// MAINTENANCE CONFIG TYPES
// ============================================================================

export const MaintenanceConfigSchema = z.object({
  reciteEverySteps: z.number().min(1).default(8),
  reflectEveryNodes: z.number().min(1).default(1),
  compactWhenTokenUsagePct: z.number().min(0.1).max(0.95).default(0.75),
});

export type MaintenanceConfig = z.infer<typeof MaintenanceConfigSchema>;

// ============================================================================
// GLOBAL CONFIG TYPES
// ============================================================================

export const GlobalConfigSchema = z.object({
  maxParallelism: z.number().min(1).default(4),
  tokenBudget: z.number().min(1024).default(20000),
  maintenance: MaintenanceConfigSchema.default({}),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// ============================================================================
// TASK GRAPH TYPES
// ============================================================================

export const TaskGraphSchema = z.object({
  version: z.literal('1.0'),
  runId: z.string().min(8),
  objective: z.string().min(1),
  constraints: z.array(ConstraintSchema).default([]),
  global: GlobalConfigSchema.default({}),
  nodes: z.array(NodeSpecSchema).min(1),
});

export type TaskGraph = z.infer<typeof TaskGraphSchema>;

// ============================================================================
// RUN SPEC TYPES
// ============================================================================

export const RunSpecSchema = z.object({
  runId: z.string().min(8),
  objective: z.string().min(1),
  input: z.record(z.unknown()).optional(),
});

export type RunSpec = z.infer<typeof RunSpecSchema>;

// ============================================================================
// RUN RESULT TYPES
// ============================================================================

export const RunResultSchema = z.object({
  runId: z.string(),
  status: z.enum(['complete', 'failed', 'running', 'pending']),
  outputs: z.array(z.object({
    name: z.string(),
    handle: z.string(),
  })),
  error: z.string().optional(),
});

export type RunResult = z.infer<typeof RunResultSchema>;

// ============================================================================
// SESSION EVENT TYPES
// ============================================================================

export const SessionEventSchema = z.object({
  runId: z.string(),
  nodeId: z.string().optional(),
  stepId: z.string().optional(),
  type: z.string(),
  ts: z.string().datetime(),
  refs: z.array(z.string()).optional().default([]),
  payload: z.unknown().optional(),
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;

// ============================================================================
// COMPACTION EVENT TYPES (Schema-driven, reversible)
// ============================================================================

export const DecisionSchema = z.object({
  decision: z.string(),
  reason: z.string(),
  evidenceRefs: z.array(z.string()).default([]),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const FailureSchema = z.object({
  symptom: z.string(),
  resolutionStatus: z.enum(['open', 'mitigated', 'resolved']),
  evidenceRefs: z.array(z.string()).default([]),
});

export type Failure = z.infer<typeof FailureSchema>;

export const CompactionSummarySchema = z.object({
  goal: z.string(),
  decisions: z.array(DecisionSchema),
  constraints: z.array(z.object({
    text: z.string(),
    strength: z.enum(['hard', 'soft']),
  })).default([]),
  openQuestions: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).min(1),
  failuresSoFar: z.array(FailureSchema).default([]),
});

export type CompactionSummary = z.infer<typeof CompactionSummarySchema>;

export const CompactionEventSchema = z.object({
  runId: z.string(),
  nodeId: z.string().optional(),
  span: z.object({
    fromEventId: z.string(),
    toEventId: z.string(),
  }),
  summary: CompactionSummarySchema,
  artifactsIndex: z.array(z.object({
    name: z.string(),
    handle: z.string(),
    shortSummary: z.string(),
    tags: z.array(z.string()).default([]),
  })),
  createdAt: z.string().datetime(),
});

export type CompactionEvent = z.infer<typeof CompactionEventSchema>;

// ============================================================================
// MEMORY DELTA TYPES (Staged updates)
// ============================================================================

export const MemoryItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  evidenceRefs: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
});

export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const MemoryAddsSchema = z.object({
  facts: z.array(MemoryItemSchema).default([]),
  constraints: z.array(MemoryItemSchema).default([]),
  preferences: z.array(MemoryItemSchema).default([]),
  tactics: z.array(MemoryItemSchema).default([]),
  pitfalls: z.array(MemoryItemSchema).default([]),
});

export type MemoryAdds = z.infer<typeof MemoryAddsSchema>;

export const MemoryDeltaSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  adds: MemoryAddsSchema,
  createdAt: z.string().datetime(),
});

export type MemoryDelta = z.infer<typeof MemoryDeltaSchema>;

// ============================================================================
// PLAYBOOK DIFF TYPES (ACE-style typed diffs)
// ============================================================================

export const PlaybookOpSchema = z.object({
  op: z.enum(['ADD_BULLET', 'REMOVE_BULLET', 'EDIT_BULLET']),
  targetFile: z.enum(['playbook.md', 'pitfalls.md', 'policies.md']),
  bulletId: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  reason: z.string(),
  evidenceRefs: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1).default(0.7),
});

export type PlaybookOp = z.infer<typeof PlaybookOpSchema>;

export const PlaybookDiffSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  ops: z.array(PlaybookOpSchema).min(1),
  createdAt: z.string().datetime(),
});

export type PlaybookDiff = z.infer<typeof PlaybookDiffSchema>;

// ============================================================================
// SKILL METADATA TYPES
// ============================================================================

export const SkillMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
});

export type SkillMeta = z.infer<typeof SkillMetaSchema>;

// ============================================================================
// CONTEXT TYPES (Compiled context for LLM)
// ============================================================================

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});

export type Message = z.infer<typeof MessageSchema>;

export const CompiledContextSchema = z.object({
  system: z.string(),
  messages: z.array(MessageSchema),
});

export type CompiledContext = z.infer<typeof CompiledContextSchema>;

// ============================================================================
// NODE STATUS TYPES (For tracking execution)
// ============================================================================

export const NodeStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
]);

export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const NodeExecutionStateSchema = z.object({
  nodeId: z.string(),
  status: NodeStatusSchema,
  attempts: z.number().default(0),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  outputHandles: z.array(z.string()).default([]),
});

export type NodeExecutionState = z.infer<typeof NodeExecutionStateSchema>;

// ============================================================================
// REFLECTION TYPES (Self-improvement)
// ============================================================================

export const ReflectionSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  whatWorked: z.array(z.string()),
  whatFailed: z.array(z.string()),
  nextTime: z.array(z.string()),
  missingInfo: z.array(z.string()),
  brittleAssumptions: z.array(z.string()),
  createdAt: z.string().datetime(),
});

export type Reflection = z.infer<typeof ReflectionSchema>;

// ============================================================================
// TODO/PLAN TYPES (Recitation)
// ============================================================================

export const TodoSchema = z.object({
  goal: z.string(),
  subgoals: z.array(z.string()),
  nextActions: z.array(z.string()),
  done: z.array(z.string()),
  openQuestions: z.array(z.string()),
  blockers: z.array(z.string()),
  pitfallsExcerpt: z.array(z.string()),
});

export type Todo = z.infer<typeof TodoSchema>;
