/**
 * Maintenance - Always-on maintenance loop for the agent
 * 
 * Includes:
 * - Compaction: Schema-driven context compression
 * - Recitation: Rewrite todo.md to keep goals at end of context
 * - Reflection: Produce structured reflection artifacts
 * - Curation: Produce typed diffs for playbook and memory
 */

import { v4 as uuidv4 } from 'uuid';
import {
  RunSpec,
  TaskGraph,
  NodeSpec,
  CompactionEvent,
  CompactionEventSchema,
  MemoryDelta,
  PlaybookDiff,
  Reflection,
  ReflectionSchema,
  Todo,
  TodoSchema,
  CompiledContext,
  ArtifactHandle,
} from '../types/index.js';
import { SessionStore } from '../memory/SessionStore.js';
import { ArtifactStore } from '../memory/ArtifactStore.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { PlaybookStore } from '../memory/PlaybookStore.js';

/**
 * LLM provider interface for maintenance operations
 */
export interface MaintenanceLLMProvider {
  complete(context: CompiledContext, opts: { maxTokens: number }): Promise<string>;
}

/**
 * Configuration for maintenance
 */
export interface MaintenanceConfig {
  sessionStore: SessionStore;
  artifactStore: ArtifactStore;
  memoryStore: MemoryStore;
  playbookStore: PlaybookStore;
  llmProvider: MaintenanceLLMProvider;
  reciteEverySteps: number;
  reflectEveryNodes: number;
  compactWhenTokenUsagePct: number;
}

/**
 * Main maintenance manager
 */
export class MaintenanceManager {
  private config: MaintenanceConfig;
  private stepCount: number = 0;
  private nodeCount: number = 0;

  constructor(config: MaintenanceConfig) {
    this.config = config;
  }

  /**
   * Check if recitation is due
   */
  shouldRecite(): boolean {
    return this.stepCount > 0 && this.stepCount % this.config.reciteEverySteps === 0;
  }

  /**
   * Check if reflection is due
   */
  shouldReflect(): boolean {
    return this.nodeCount > 0 && this.nodeCount % this.config.reflectEveryNodes === 0;
  }

  /**
   * Check if compaction is needed based on token usage
   */
  shouldCompact(currentTokens: number, tokenBudget: number): boolean {
    return currentTokens / tokenBudget >= this.config.compactWhenTokenUsagePct;
  }

  /**
   * Increment step counter
   */
  recordStep(): void {
    this.stepCount++;
  }

  /**
   * Increment node counter
   */
  recordNodeComplete(): void {
    this.nodeCount++;
  }

  /**
   * Reset counters
   */
  reset(): void {
    this.stepCount = 0;
    this.nodeCount = 0;
  }
}

/**
 * Compaction - Schema-driven context compression
 */
export class Compactor {
  private sessionStore: SessionStore;
  private artifactStore: ArtifactStore;
  private llmProvider: MaintenanceLLMProvider;

  constructor(
    sessionStore: SessionStore,
    artifactStore: ArtifactStore,
    llmProvider: MaintenanceLLMProvider
  ) {
    this.sessionStore = sessionStore;
    this.artifactStore = artifactStore;
    this.llmProvider = llmProvider;
  }

  /**
   * Perform compaction for a run
   */
  async compact(run: RunSpec, nodeId?: string): Promise<CompactionEvent> {
    // Get events to compact
    const events = await this.sessionStore.getUncompactedEvents(run.runId);
    
    if (events.length === 0) {
      throw new Error('No events to compact');
    }

    // Get artifact pointers referenced in events
    const artifactRefs = new Set<string>();
    for (const event of events) {
      for (const ref of event.refs || []) {
        artifactRefs.add(ref);
      }
    }

    // Load artifact metadata
    const artifactIndex: Array<{ name: string; handle: string; shortSummary: string; tags: string[] }> = [];
    for (const ref of artifactRefs) {
      const meta = await this.artifactStore.getMetadata(ref);
      if (meta) {
        artifactIndex.push({
          name: meta.uri.split('/').pop() || 'artifact',
          handle: meta.uri,
          shortSummary: meta.shortSummary,
          tags: meta.tags,
        });
      }
    }

    // Build compaction context
    const context = this.buildCompactionContext(run, events, artifactIndex);

    // Call LLM to generate compaction summary
    const response = await this.llmProvider.complete(context, { maxTokens: 2000 });

    // Parse the compaction summary
    const summary = this.parseCompactionSummary(response);

    // Create compaction event
    const compactionEvent: CompactionEvent = CompactionEventSchema.parse({
      runId: run.runId,
      nodeId,
      span: {
        fromEventId: this.sessionStore.generateEventId(events[0]),
        toEventId: this.sessionStore.generateEventId(events[events.length - 1]),
      },
      summary,
      artifactsIndex: artifactIndex,
      createdAt: new Date().toISOString(),
    });

    // Store the compaction event
    await this.sessionStore.appendCompactionEvent(compactionEvent);

    return compactionEvent;
  }

  /**
   * Build context for compaction LLM call
   */
  private buildCompactionContext(
    run: RunSpec,
    events: any[],
    artifactIndex: any[]
  ): CompiledContext {
    const eventSummary = events
      .slice(-50) // Limit to recent events
      .map(e => `[${e.ts}] ${e.type}: ${JSON.stringify(e.payload || {}).substring(0, 200)}`)
      .join('\n');

    const artifacts = artifactIndex
      .map(a => `- ${a.name}: ${a.shortSummary}`)
      .join('\n');

    return {
      system: `You are compacting a session history into a structured summary.

The summary must include:
1. goal: The current objective
2. decisions: Key decisions made (with reasons)
3. constraints: Hard and soft constraints discovered
4. openQuestions: Unresolved questions
5. nextActions: Next 3-7 planned actions
6. failuresSoFar: Any failures encountered (preserve these!)

Output a JSON object matching this schema. Preserve important context but compress verbose history.`,
      messages: [
        {
          role: 'user',
          content: `## Run Objective
${run.objective}

## Recent Events
${eventSummary}

## Artifacts
${artifacts}

Please produce a compaction summary JSON.`,
        },
      ],
    };
  }

  /**
   * Parse compaction summary from LLM response
   */
  private parseCompactionSummary(response: string): any {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Fall through to default
    }

    // Return minimal summary if parsing fails
    return {
      goal: 'Continue execution',
      decisions: [],
      constraints: [],
      openQuestions: [],
      nextActions: ['Continue with next step'],
      failuresSoFar: [],
    };
  }
}

/**
 * Reciter - Keeps todo.md updated for attention anchoring
 */
export class Reciter {
  private artifactStore: ArtifactStore;

  constructor(artifactStore: ArtifactStore) {
    this.artifactStore = artifactStore;
  }

  /**
   * Update the todo.md for a run
   */
  async recite(
    run: RunSpec,
    graph: TaskGraph,
    completedNodeIds: Set<string>,
    currentNodeId?: string,
    observations?: string[]
  ): Promise<ArtifactHandle> {
    const todo = this.buildTodo(run, graph, completedNodeIds, currentNodeId, observations);
    const markdown = this.formatTodoMarkdown(todo);

    return this.artifactStore.putMarkdown(
      `runs/${run.runId}/nodes/plan`,
      'todo.md',
      markdown,
      { tags: ['recitation', 'todo'], shortSummary: `TODO: ${completedNodeIds.size}/${graph.nodes.length} complete` }
    );
  }

  /**
   * Build a Todo object from current state
   */
  private buildTodo(
    run: RunSpec,
    graph: TaskGraph,
    completedNodeIds: Set<string>,
    currentNodeId?: string,
    observations?: string[]
  ): Todo {
    const done = graph.nodes
      .filter(n => completedNodeIds.has(n.id))
      .map(n => `${n.id}: ${n.objective}`);

    const pending = graph.nodes.filter(n => !completedNodeIds.has(n.id));
    const ready = pending.filter(n => n.deps.every(d => completedNodeIds.has(d)));

    const nextActions = ready.slice(0, 5).map(n => 
      n.id === currentNodeId ? `[CURRENT] ${n.id}: ${n.objective}` : `${n.id}: ${n.objective}`
    );

    const blockers = pending
      .filter(n => !ready.includes(n))
      .slice(0, 3)
      .map(n => `${n.id} blocked by: ${n.deps.filter(d => !completedNodeIds.has(d)).join(', ')}`);

    return TodoSchema.parse({
      goal: run.objective,
      subgoals: graph.nodes.map(n => n.objective),
      nextActions,
      done,
      openQuestions: observations?.filter(o => o.includes('?')) || [],
      blockers,
      pitfallsExcerpt: [],
    });
  }

  /**
   * Format a Todo into markdown
   */
  private formatTodoMarkdown(todo: Todo): string {
    const lines: string[] = [
      `# TODO`,
      '',
      '## Goal',
      todo.goal,
      '',
      '## Next Actions',
      ...todo.nextActions.map((a, i) => `${i + 1}. ${a}`),
      '',
      '## Done',
      ...(todo.done.length > 0 ? todo.done.map(d => `- ✓ ${d}`) : ['(none yet)']),
      '',
    ];

    if (todo.blockers.length > 0) {
      lines.push('## Blockers');
      lines.push(...todo.blockers.map(b => `- ${b}`));
      lines.push('');
    }

    if (todo.openQuestions.length > 0) {
      lines.push('## Open Questions');
      lines.push(...todo.openQuestions.map(q => `- ${q}`));
      lines.push('');
    }

    if (todo.pitfallsExcerpt.length > 0) {
      lines.push('## What to Avoid');
      lines.push(...todo.pitfallsExcerpt.map(p => `- ⚠️ ${p}`));
    }

    return lines.join('\n');
  }
}

/**
 * Reflector - Produces structured reflection artifacts
 */
export class Reflector {
  private artifactStore: ArtifactStore;
  private llmProvider: MaintenanceLLMProvider;

  constructor(
    artifactStore: ArtifactStore,
    llmProvider: MaintenanceLLMProvider
  ) {
    this.artifactStore = artifactStore;
    this.llmProvider = llmProvider;
  }

  /**
   * Produce a reflection for a completed node
   */
  async reflect(
    run: RunSpec,
    node: NodeSpec,
    observations: string[],
    errors: string[]
  ): Promise<Reflection> {
    const context = this.buildReflectionContext(run, node, observations, errors);
    const response = await this.llmProvider.complete(context, { maxTokens: 1500 });
    const reflection = this.parseReflection(run.runId, node.id, response);

    // Store reflection as artifact
    await this.artifactStore.putJson(
      node.scope.artifactNamespace,
      'reflection.json',
      reflection,
      { tags: ['reflection', 'meta'], shortSummary: `Reflection for ${node.id}` }
    );

    return reflection;
  }

  /**
   * Build context for reflection LLM call
   */
  private buildReflectionContext(
    run: RunSpec,
    node: NodeSpec,
    observations: string[],
    errors: string[]
  ): CompiledContext {
    return {
      system: `You are reflecting on the execution of a task node.

Produce a structured reflection with:
1. whatWorked: Approaches that succeeded
2. whatFailed: Approaches that failed (include wrong turns!)
3. nextTime: What to do differently next time
4. missingInfo: Information that was lacking
5. brittleAssumptions: Assumptions that may not hold

Output a JSON object. Be specific and actionable.`,
      messages: [
        {
          role: 'user',
          content: `## Node
- ID: ${node.id}
- Objective: ${node.objective}
- Type: ${node.type}

## Observations
${observations.map(o => `- ${o}`).join('\n')}

## Errors
${errors.map(e => `- ${e}`).join('\n') || '(none)'}

Please produce a reflection JSON.`,
        },
      ],
    };
  }

  /**
   * Parse reflection from LLM response
   */
  private parseReflection(runId: string, nodeId: string, response: string): Reflection {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return ReflectionSchema.parse({
          runId,
          nodeId,
          whatWorked: parsed.whatWorked || [],
          whatFailed: parsed.whatFailed || [],
          nextTime: parsed.nextTime || [],
          missingInfo: parsed.missingInfo || [],
          brittleAssumptions: parsed.brittleAssumptions || [],
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      // Fall through to default
    }

    return ReflectionSchema.parse({
      runId,
      nodeId,
      whatWorked: [],
      whatFailed: [],
      nextTime: [],
      missingInfo: [],
      brittleAssumptions: [],
      createdAt: new Date().toISOString(),
    });
  }
}

/**
 * Curator - Produces typed diffs for memory and playbook
 */
export class Curator {
  private artifactStore: ArtifactStore;
  private memoryStore: MemoryStore;
  private playbookStore: PlaybookStore;
  private llmProvider: MaintenanceLLMProvider;

  constructor(
    artifactStore: ArtifactStore,
    memoryStore: MemoryStore,
    playbookStore: PlaybookStore,
    llmProvider: MaintenanceLLMProvider
  ) {
    this.artifactStore = artifactStore;
    this.memoryStore = memoryStore;
    this.playbookStore = playbookStore;
    this.llmProvider = llmProvider;
  }

  /**
   * Curate updates from a reflection
   */
  async curate(
    run: RunSpec,
    node: NodeSpec,
    reflection: Reflection
  ): Promise<{ memoryDelta: MemoryDelta; playbookDiff: PlaybookDiff }> {
    // Generate memory delta from reflection
    const memoryDelta = this.generateMemoryDelta(run, node, reflection);

    // Generate playbook diff from reflection
    const playbookDiff = this.generatePlaybookDiff(run, node, reflection);

    // Store as artifacts (staging only - not applied yet)
    await this.artifactStore.putJson(
      node.scope.artifactNamespace,
      'memory_delta.json',
      memoryDelta,
      { tags: ['memory', 'delta'], shortSummary: `Memory delta from ${node.id}` }
    );

    await this.artifactStore.putJson(
      node.scope.artifactNamespace,
      'playbook_diff.json',
      playbookDiff,
      { tags: ['playbook', 'diff'], shortSummary: `Playbook diff from ${node.id}` }
    );

    return { memoryDelta, playbookDiff };
  }

  /**
   * Generate memory delta from reflection
   */
  private generateMemoryDelta(
    run: RunSpec,
    node: NodeSpec,
    reflection: Reflection
  ): MemoryDelta {
    const evidenceRef = `${node.scope.artifactNamespace}/reflection.json`;

    return MemoryStore.createDelta(run.runId, node.id, {
      facts: reflection.whatWorked.map(w => 
        MemoryStore.createItem(w, [evidenceRef], 0.8)
      ),
      pitfalls: reflection.whatFailed.map(f => 
        MemoryStore.createItem(f, [evidenceRef], 0.9)
      ),
      tactics: reflection.nextTime.map(n => 
        MemoryStore.createItem(n, [evidenceRef], 0.7)
      ),
    });
  }

  /**
   * Generate playbook diff from reflection
   */
  private generatePlaybookDiff(
    run: RunSpec,
    node: NodeSpec,
    reflection: Reflection
  ): PlaybookDiff {
    const evidenceRef = `${node.scope.artifactNamespace}/reflection.json`;
    const ops: any[] = [];

    // Add successful tactics to playbook
    for (const tactic of reflection.nextTime.slice(0, 3)) {
      ops.push(PlaybookStore.addBullet(
        'playbook.md',
        tactic,
        `Learned from ${node.id}`,
        [evidenceRef],
        0.7
      ));
    }

    // Add failures to pitfalls
    for (const failure of reflection.whatFailed.slice(0, 3)) {
      ops.push(PlaybookStore.addBullet(
        'pitfalls.md',
        failure,
        `Failure in ${node.id}`,
        [evidenceRef],
        0.9
      ));
    }

    // Ensure at least one op
    if (ops.length === 0) {
      ops.push(PlaybookStore.addBullet(
        'playbook.md',
        `Completed ${node.type} node: ${node.objective.substring(0, 50)}`,
        `Node ${node.id} completed`,
        [evidenceRef],
        0.5
      ));
    }

    return PlaybookStore.createDiff(run.runId, node.id, ops);
  }

  /**
   * Apply staged updates (only for commit nodes)
   */
  async applyUpdates(
    memoryDeltaPath: string,
    playbookDiffPath: string
  ): Promise<void> {
    await this.memoryStore.applyMemoryDeltaFromFile(memoryDeltaPath);
    await this.playbookStore.applyDiffFromFile(playbookDiffPath);
  }
}
