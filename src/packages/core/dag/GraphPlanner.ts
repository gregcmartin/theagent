/**
 * GraphPlanner - LLM-powered DAG generation
 * 
 * Takes an objective and produces a TaskGraph using the LLM.
 * Outputs both the graph and an initial todo.md for recitation.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  TaskGraph,
  TaskGraphSchema,
  RunSpec,
  NodeSpec,
  SkillMeta,
  CompiledContext,
} from '../types/index.js';
import { TaskGraphBuilder } from './TaskGraph.js';
import { ArtifactStore } from '../memory/ArtifactStore.js';

/**
 * LLM provider interface for planning
 */
export interface PlannerLLMProvider {
  complete(context: CompiledContext, opts: { maxTokens: number }): Promise<string>;
}

/**
 * Configuration for the planner
 */
export interface GraphPlannerConfig {
  llmProvider: PlannerLLMProvider;
  skillIndex: SkillMeta[];
  artifactStore: ArtifactStore;
}

/**
 * Result of planning
 */
export interface PlanResult {
  graph: TaskGraph;
  todoMarkdown: string;
  todoArtifactHandle: string;
}

/**
 * Graph planner that uses LLM to generate DAGs
 */
export class GraphPlanner {
  private config: GraphPlannerConfig;

  constructor(config: GraphPlannerConfig) {
    this.config = config;
  }

  /**
   * Plan a TaskGraph for a run
   */
  async plan(run: RunSpec): Promise<PlanResult> {
    const context = this.buildPlanningContext(run);
    
    // Call LLM to generate the plan
    const response = await this.config.llmProvider.complete(context, { maxTokens: 4000 });
    
    // Parse the response to extract the TaskGraph
    const graph = this.parseGraphFromResponse(run, response);
    
    // Generate todo.md for recitation
    const todoMarkdown = this.generateTodoMarkdown(run, graph);
    
    // Store todo.md as an artifact
    const todoHandle = await this.config.artifactStore.putMarkdown(
      `runs/${run.runId}/nodes/plan`,
      'todo.md',
      todoMarkdown,
      { tags: ['recitation', 'plan'], shortSummary: `Plan for: ${run.objective}` }
    );

    return {
      graph,
      todoMarkdown,
      todoArtifactHandle: todoHandle.uri,
    };
  }

  /**
   * Build the planning context for the LLM
   */
  private buildPlanningContext(run: RunSpec): CompiledContext {
    const skillList = this.config.skillIndex
      .map(s => `- **${s.name}**: ${s.description}`)
      .join('\n');

    const system = `# Task Planning

You are planning the execution of a complex task. Your job is to decompose the objective into a directed acyclic graph (DAG) of nodes.

## Available Skills

${skillList}

## Node Types

- **plan**: Create sub-plans or decompose objectives
- **research**: Gather information, analyze data
- **execute**: Perform actions, create artifacts
- **synthesize**: Combine results from multiple nodes
- **verify**: Validate outputs against acceptance criteria
- **curate**: Produce memory deltas and playbook diffs
- **commit**: Finalize and merge staged updates

## Output Format

Respond with a JSON object containing the TaskGraph. The graph should have:
- nodes: Array of node specifications
- constraints: Any hard/soft constraints for the run

Each node should specify:
- id: Unique identifier (lowercase, underscores)
- type: One of the node types above
- objective: What this node should accomplish
- deps: Array of node IDs this depends on
- skillHints: Suggested skills to use
- acceptance: Criteria for success

## Rules

1. Start with a "plan" node that has no dependencies
2. End with a "commit" node that depends on all final nodes
3. Maximize parallelism where possible (don't create unnecessary sequential deps)
4. Each node should have clear, testable acceptance criteria
5. Keep nodes focused - prefer more smaller nodes over fewer large ones`;

    const userMessage = `## Objective

${run.objective}

${run.input ? `## Additional Context\n\n${JSON.stringify(run.input, null, 2)}` : ''}

Please create a TaskGraph to accomplish this objective. Return ONLY the JSON graph, no explanation.`;

    return {
      system,
      messages: [{ role: 'user', content: userMessage }],
    };
  }

  /**
   * Parse a TaskGraph from LLM response
   */
  private parseGraphFromResponse(run: RunSpec, response: string): TaskGraph {
    try {
      // Extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      // Build a valid TaskGraph
      const builder = new TaskGraphBuilder(run.objective, run.runId);

      // Add constraints if present and is an array
      if (parsed.constraints && Array.isArray(parsed.constraints)) {
        for (const c of parsed.constraints) {
          if (c && c.text) {
            builder.addConstraint(c.id || uuidv4().substring(0, 8), c.text, c.strength || 'hard');
          }
        }
      }

      // Add nodes
      if (parsed.nodes && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
        for (const node of parsed.nodes) {
          try {
            builder.addNode(this.normalizeNode(run.runId, node));
          } catch (nodeError) {
            // Skip invalid nodes, continue with others
            console.warn('Skipping invalid node:', nodeError);
          }
        }
      }

      // Check if we have valid nodes before building
      try {
        return builder.build();
      } catch (buildError) {
        // If build fails, fall back to default graph
        console.warn('Build failed, using default graph:', buildError);
        return this.createDefaultGraph(run);
      }
    } catch (error) {
      console.warn('Failed to parse graph from response:', error);
      return this.createDefaultGraph(run);
    }
  }

  /**
   * Normalize a node from LLM output to match our schema
   */
  private normalizeNode(runId: string, node: any): NodeSpec {
    const id = node.id || `node_${uuidv4().substring(0, 8)}`;
    const type = node.type || 'execute';
    
    // Normalize acceptance tests
    let acceptance = node.acceptance;
    if (!acceptance || !Array.isArray(acceptance) || acceptance.length === 0) {
      acceptance = [
        {
          id: 'default_acceptance',
          type: 'checks',
          criteria: 'Task completed successfully',
          requiresArtifacts: [],
        },
      ];
    } else {
      // Ensure each acceptance test has valid id (min 3 chars)
      acceptance = acceptance.map((a: any, idx: number) => ({
        id: a.id?.length >= 3 ? a.id : `acc_${idx}`,
        type: a.type || 'checks',
        criteria: a.criteria || 'Task completed',
        requiresArtifacts: a.requiresArtifacts || [],
      }));
    }
    
    return {
      id,
      type,
      objective: node.objective || 'Execute task',
      deps: Array.isArray(node.deps) ? node.deps : [],
      skillHints: Array.isArray(node.skillHints) ? node.skillHints : [],
      scope: {
        artifactNamespace: `runs/${runId}/nodes/${id}`,
        artifactPolicy: {
          allowReadsFrom: Array.isArray(node.deps) ? node.deps.map((d: string) => `runs/${runId}/nodes/${d}`) : [],
          writeMode: 'scopedOnly',
          pointerFirst: true,
        },
        memoryWritePolicy: type === 'commit' ? 'curatorOnly' : 'stageDeltaOnly',
        sessionVisibility: 'ownPlusDeps',
        allowedSkills: Array.isArray(node.skillHints) ? node.skillHints : [],
      },
      io: {
        inputs: Array.isArray(node.inputs) ? node.inputs : [],
        outputs: Array.isArray(node.outputs) ? node.outputs : [],
      },
      acceptance,
    };
  }

  /**
   * Create a default graph when parsing fails
   */
  private createDefaultGraph(run: RunSpec): TaskGraph {
    return new TaskGraphBuilder(run.objective, run.runId)
      .addConstraint('c1', 'Use pointer-first artifacts', 'hard')
      .addConstraint('c2', 'Stage memory updates only', 'hard')
      .node('plan', 'plan', 'Analyze objective and create execution plan')
        .namespace(`runs/${run.runId}/nodes/plan`)
        .outputs({ name: 'analysis.md', type: 'markdown', description: 'Analysis and plan' })
        .acceptance('a1', 'checks', 'Plan is comprehensive and actionable')
        .add()
      .node('execute', 'execute', run.objective)
        .deps('plan')
        .namespace(`runs/${run.runId}/nodes/execute`)
        .allowReadsFrom(`runs/${run.runId}/nodes/plan`)
        .outputs({ name: 'result.json', type: 'json', description: 'Execution result' })
        .acceptance('a2', 'checks', 'Objective is satisfied')
        .add()
      .node('commit', 'commit', 'Finalize and commit results')
        .deps('execute')
        .namespace(`runs/${run.runId}/nodes/commit`)
        .allowReadsFrom(`runs/${run.runId}/nodes/execute`)
        .memoryPolicy('curatorOnly')
        .outputs({ name: 'final.json', type: 'json', description: 'Final status' })
        .acceptance('a3', 'checks', 'All updates committed')
        .add()
      .build();
  }

  /**
   * Generate todo.md for recitation
   */
  private generateTodoMarkdown(run: RunSpec, graph: TaskGraph): string {
    const lines: string[] = [
      `# TODO: ${run.objective}`,
      '',
      '## Goal',
      run.objective,
      '',
      '## Subgoals',
    ];

    // List all node objectives as subgoals
    for (const node of graph.nodes) {
      lines.push(`- [ ] ${node.id}: ${node.objective}`);
    }

    lines.push('');
    lines.push('## Next Actions');
    
    // Find nodes with no dependencies (ready to start)
    const ready = graph.nodes.filter(n => n.deps.length === 0);
    for (const node of ready) {
      lines.push(`1. Start "${node.id}": ${node.objective}`);
    }

    lines.push('');
    lines.push('## Done');
    lines.push('(None yet)');
    
    lines.push('');
    lines.push('## Open Questions');
    lines.push('- What are the acceptance criteria for success?');
    
    lines.push('');
    lines.push('## Blockers');
    lines.push('(None)');
    
    lines.push('');
    lines.push('## What to Avoid (Pitfalls)');
    lines.push('- Avoid injecting large outputs directly into prompts');
    lines.push('- Avoid writing to memory directly (stage updates only)');

    return lines.join('\n');
  }

  /**
   * Update todo.md with current progress
   */
  async updateTodo(
    run: RunSpec,
    graph: TaskGraph,
    completedNodeIds: Set<string>,
    currentNodeId?: string
  ): Promise<string> {
    const lines: string[] = [
      `# TODO: ${run.objective}`,
      '',
      '## Goal',
      run.objective,
      '',
      '## Subgoals',
    ];

    // List all node objectives with completion status
    for (const node of graph.nodes) {
      const status = completedNodeIds.has(node.id) ? 'x' : ' ';
      const current = node.id === currentNodeId ? ' ← CURRENT' : '';
      lines.push(`- [${status}] ${node.id}: ${node.objective}${current}`);
    }

    lines.push('');
    lines.push('## Next Actions');
    
    // Find nodes that are ready (deps completed, not yet done)
    const ready = graph.nodes.filter(n => 
      !completedNodeIds.has(n.id) && 
      n.deps.every(d => completedNodeIds.has(d))
    );
    for (let i = 0; i < Math.min(ready.length, 3); i++) {
      lines.push(`${i + 1}. Execute "${ready[i].id}": ${ready[i].objective}`);
    }

    lines.push('');
    lines.push('## Done');
    
    const completed = graph.nodes.filter(n => completedNodeIds.has(n.id));
    if (completed.length === 0) {
      lines.push('(None yet)');
    } else {
      for (const node of completed) {
        lines.push(`- ${node.id}: ${node.objective}`);
      }
    }

    return lines.join('\n');
  }
}
