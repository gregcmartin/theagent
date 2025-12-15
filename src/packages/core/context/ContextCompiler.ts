/**
 * ContextCompiler - ADK-style processor pipeline for building LLM context
 * 
 * Every LLM call is built from a fresh compiled view, not appended transcripts.
 * Processors are extensible and run in order to build the final context.
 */

import {
  CompiledContext,
  RunSpec,
  NodeSpec,
  SkillMeta,
  ArtifactHandle,
  MemoryItem,
  Todo,
} from '../types/index.js';

/**
 * Input for context compilation
 */
export interface CompileInput {
  run: RunSpec;
  node: NodeSpec;
  skillIndex: SkillMeta[];
  loadedSkills: string[];
  memoryHits: Array<{ item: MemoryItem; category: string; score: number }>;
  artifactPointers: ArtifactHandle[];
  todoMarkdown: string;
  recentObservations?: string[];
  compactionSummary?: string;
}

/**
 * Context processor interface
 */
export interface ContextProcessor {
  name: string;
  priority: number;
  process(input: CompileInput, context: ContextBuilder): Promise<void>;
}

/**
 * Builder for constructing context incrementally
 */
export class ContextBuilder {
  private systemParts: string[] = [];
  private messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private tokenEstimate: number = 0;

  /**
   * Add to system prompt
   */
  addSystem(content: string): void {
    this.systemParts.push(content);
    this.tokenEstimate += this.estimateTokens(content);
  }

  /**
   * Add a user message
   */
  addUserMessage(content: string): void {
    this.messages.push({ role: 'user', content });
    this.tokenEstimate += this.estimateTokens(content);
  }

  /**
   * Add an assistant message
   */
  addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content });
    this.tokenEstimate += this.estimateTokens(content);
  }

  /**
   * Get current token estimate
   */
  getTokenEstimate(): number {
    return this.tokenEstimate;
  }

  /**
   * Estimate tokens in text (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Build the final compiled context
   */
  build(): CompiledContext {
    return {
      system: this.systemParts.join('\n\n'),
      messages: this.messages,
    };
  }
}

/**
 * Main context compiler
 */
export class ContextCompiler {
  private processors: ContextProcessor[] = [];

  constructor() {
    // Register default processors
    this.registerDefaultProcessors();
  }

  /**
   * Register a processor
   */
  registerProcessor(processor: ContextProcessor): void {
    this.processors.push(processor);
    // Sort by priority (lower runs first)
    this.processors.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Register default processors
   */
  private registerDefaultProcessors(): void {
    this.registerProcessor(new PrefixProcessor());
    this.registerProcessor(new ScopeProcessor());
    this.registerProcessor(new RetrievalProcessor());
    this.registerProcessor(new ArtifactPointerProcessor());
    this.registerProcessor(new SkillIndexProcessor());
    this.registerProcessor(new SkillLoadProcessor());
    this.registerProcessor(new RecitationProcessor());
    this.registerProcessor(new CompactionGuardProcessor());
    this.registerProcessor(new TaskMessageProcessor());
  }

  /**
   * Compile context for an LLM call
   */
  async compile(input: CompileInput): Promise<CompiledContext> {
    const builder = new ContextBuilder();

    for (const processor of this.processors) {
      await processor.process(input, builder);
    }

    const context = builder.build();
    
    // Ensure we have at least one message
    if (context.messages.length === 0) {
      context.messages.push({
        role: 'user',
        content: `Execute the following objective: ${input.node.objective}`,
      });
    }

    return context;
  }
}

/**
 * Processor 1: Stable Prefix
 * Adds stable identity, rules, and output schemas (cache-friendly)
 */
class PrefixProcessor implements ContextProcessor {
  name = 'PrefixProcessor';
  priority = 10;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    context.addSystem(`# Agent Identity

You are an autonomous agent executing a task within the Agentic Harness Framework.
You operate with strict discipline around context management, memory, and artifacts.

## Core Principles

1. **Pointer-first artifacts**: Never paste large outputs. Write to artifacts, reference by handle.
2. **Staged memory updates**: Produce MemoryDelta artifacts. Never write to memory directly.
3. **Token discipline**: Keep context lean. Request compaction if needed.
4. **Acceptance criteria**: Every action should move toward satisfying the node's acceptance tests.
5. **Recitation**: Regularly update todo.md to stay oriented.

## Output Format

When producing outputs, use structured formats:
- For artifacts: Specify path, type, and content clearly
- For memory deltas: Use the MemoryDelta schema
- For playbook updates: Use PlaybookDiff schema
- For tool calls: Specify tool name and parameters

## Run Context

- Run ID: ${input.run.runId}
- Run Objective: ${input.run.objective}`);
  }
}

/**
 * Processor 2: Scope
 * Injects node objective, acceptance criteria, and current plan/todo
 */
class ScopeProcessor implements ContextProcessor {
  name = 'ScopeProcessor';
  priority = 20;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    const node = input.node;
    
    context.addSystem(`## Current Node

- Node ID: ${node.id}
- Node Type: ${node.type}
- Objective: ${node.objective}

### Acceptance Criteria

${node.acceptance.map((a, i) => `${i + 1}. [${a.type}] ${a.criteria}`).join('\n')}

### Scope Rules

- Artifact Namespace: ${node.scope.artifactNamespace}
- Memory Write Policy: ${node.scope.memoryWritePolicy}
- Session Visibility: ${node.scope.sessionVisibility}
- Allowed Skills: ${node.scope.allowedSkills.join(', ') || 'all'}`);
  }
}

/**
 * Processor 3: Retrieval
 * Queries MemoryStore and SessionStore with relevance filters
 */
class RetrievalProcessor implements ContextProcessor {
  name = 'RetrievalProcessor';
  priority = 30;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    if (input.memoryHits.length === 0) {
      return;
    }

    const relevantMemory = input.memoryHits
      .slice(0, 10)
      .map(h => `- [${h.category}] ${h.item.text} (confidence: ${h.item.confidence.toFixed(2)})`)
      .join('\n');

    context.addSystem(`## Relevant Memory

${relevantMemory}`);
  }
}

/**
 * Processor 4: Artifact Pointers
 * Injects handle + shortSummary, not raw content
 */
class ArtifactPointerProcessor implements ContextProcessor {
  name = 'ArtifactPointerProcessor';
  priority = 40;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    if (input.artifactPointers.length === 0) {
      return;
    }

    const pointers = input.artifactPointers
      .map(a => `- **${a.uri}** [${a.type}]: ${a.shortSummary}${a.tags.length > 0 ? ` (tags: ${a.tags.join(', ')})` : ''}`)
      .join('\n');

    context.addSystem(`## Available Artifacts

${pointers}

*Use skills/tools to read artifact contents when needed. Do not request full content injection.*`);
  }
}

/**
 * Processor 5: Skill Index
 * Injects skill metadata only (name, description, tags)
 */
class SkillIndexProcessor implements ContextProcessor {
  name = 'SkillIndexProcessor';
  priority = 50;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    if (input.skillIndex.length === 0) {
      return;
    }

    const skillList = input.skillIndex
      .map(s => `- **${s.name}**: ${s.description}${s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : ''}`)
      .join('\n');

    context.addSystem(`## Available Skills

${skillList}

*Request specific skill loading if you need detailed instructions.*`);
  }
}

/**
 * Processor 6: Skill Load
 * Loads full SKILL.md content for selected skills
 */
class SkillLoadProcessor implements ContextProcessor {
  name = 'SkillLoadProcessor';
  priority = 60;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    if (input.loadedSkills.length === 0) {
      return;
    }

    for (const skillContent of input.loadedSkills) {
      context.addSystem(`### Loaded Skill

${skillContent}`);
    }
  }
}

/**
 * Processor 7: Recitation
 * Ensures todo.md and "Next actions" appear at end of context
 */
class RecitationProcessor implements ContextProcessor {
  name = 'RecitationProcessor';
  priority = 90;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    if (input.todoMarkdown) {
      context.addSystem(`## Current Plan (todo.md)

${input.todoMarkdown}`);
    }

    if (input.recentObservations && input.recentObservations.length > 0) {
      context.addSystem(`## Recent Observations

${input.recentObservations.map(o => `- ${o}`).join('\n')}`);
    }
  }
}

/**
 * Processor 8: Compaction Guard
 * Checks token budget and may request COMPACT() step
 */
class CompactionGuardProcessor implements ContextProcessor {
  name = 'CompactionGuardProcessor';
  priority = 100;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    const tokenBudget = input.node.budgets?.maxTokens || 12000;
    const currentTokens = context.getTokenEstimate();
    const usagePct = currentTokens / tokenBudget;

    if (usagePct > 0.75) {
      context.addSystem(`## ⚠️ Context Pressure Warning

Current token usage: ~${currentTokens} / ${tokenBudget} (${(usagePct * 100).toFixed(1)}%)

Consider:
1. Requesting compaction if history is long
2. Using artifact pointers instead of inline content
3. Completing current subtask before expanding scope`);
    }

    if (input.compactionSummary) {
      context.addSystem(`## Compacted History Summary

${input.compactionSummary}`);
    }
  }
}

/**
 * Processor 9: Task Message
 * Adds the actual user task message to execute
 */
class TaskMessageProcessor implements ContextProcessor {
  name = 'TaskMessageProcessor';
  priority = 110;

  async process(input: CompileInput, context: ContextBuilder): Promise<void> {
    const node = input.node;
    
    context.addUserMessage(`Please execute the following task:

**Objective**: ${node.objective}

**Node Type**: ${node.type}

Produce the required outputs and ensure all acceptance criteria are satisfied.

If you need to create artifacts, specify them in your response using this format:
\`\`\`artifact
path: <artifact-path>
type: <markdown|json|text|code>
---
<content>
\`\`\`

When complete, summarize what was accomplished.`);
  }
}

// Export processors for extensibility
export {
  PrefixProcessor,
  ScopeProcessor,
  RetrievalProcessor,
  ArtifactPointerProcessor,
  SkillIndexProcessor,
  SkillLoadProcessor,
  RecitationProcessor,
  CompactionGuardProcessor,
  TaskMessageProcessor,
};
