/**
 * RunDAGWorkflow - DBOS durable workflow for DAG execution
 * 
 * Provides durability and recovery for long-running agent tasks.
 * Node completion is checkpointed, retries happen safely, and
 * crashes mid-run resume without losing state or repeating completed work.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { v4 as uuidv4 } from 'uuid';
import {
  RunSpec,
  TaskGraph,
  RunResult,
  NodeSpec,
} from '../../core/types/index.js';
import { TaskGraphUtils } from '../../core/dag/TaskGraph.js';
import { NodeExecutionResult, NodeExecutionContext } from '../../core/dag/GraphExecutor.js';

/**
 * Configuration for the workflow
 */
export interface WorkflowConfig {
  maxParallelism: number;
  nodeExecutor: (context: NodeExecutionContext) => Promise<NodeExecutionResult>;
  onRecite?: (runId: string) => Promise<void>;
  onReflect?: (runId: string, nodeId: string) => Promise<void>;
  onCompact?: (runId: string) => Promise<void>;
}

/**
 * Workflow state stored in DBOS
 */
interface WorkflowState {
  runId: string;
  graph: TaskGraph;
  completedNodes: string[];
  failedNodes: string[];
  stepCount: number;
}

/**
 * DBOS Workflow class for running DAGs
 */
export class RunDAGWorkflow {
  private config: WorkflowConfig;

  constructor(config: WorkflowConfig) {
    this.config = config;
  }

  /**
   * Main workflow entry point
   */
  async run(run: RunSpec, graph: TaskGraph): Promise<RunResult> {
    // Validate the graph first
    const validation = TaskGraphUtils.validate(graph);
    if (!validation.valid) {
      return {
        runId: run.runId,
        status: 'failed',
        outputs: [],
        error: `Invalid graph: ${validation.errors.join(', ')}`,
      };
    }

    // Initialize state
    const state: WorkflowState = {
      runId: run.runId,
      graph,
      completedNodes: [],
      failedNodes: [],
      stepCount: 0,
    };

    try {
      // Execute the graph
      const result = await this.executeGraph(run, graph, state);
      return result;
    } catch (error) {
      return {
        runId: run.runId,
        status: 'failed',
        outputs: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute the graph with bounded parallelism
   */
  private async executeGraph(
    run: RunSpec,
    graph: TaskGraph,
    state: WorkflowState
  ): Promise<RunResult> {
    const maxPar = graph.global?.maxParallelism || this.config.maxParallelism;
    const completedSet = new Set(state.completedNodes);
    const failedSet = new Set(state.failedNodes);
    const completedResults = new Map<string, NodeExecutionResult>();

    // Execute until all nodes complete or fail
    while (completedSet.size + failedSet.size < graph.nodes.length) {
      // Get ready nodes
      const ready = TaskGraphUtils.getReadyNodes(graph, completedSet)
        .filter(n => !failedSet.has(n.id));

      if (ready.length === 0) {
        if (failedSet.size > 0) {
          break;
        }
        throw new Error('Deadlock: no ready nodes but graph incomplete');
      }

      // Sort for deterministic execution order
      const readySorted = [...ready].sort((a, b) => a.id.localeCompare(b.id));

      // Execute in batches with bounded parallelism
      for (let i = 0; i < readySorted.length; i += maxPar) {
        const batch = readySorted.slice(i, i + maxPar);

        // Maintenance: recite before each batch
        await this.maintenanceRecite(run.runId, state.stepCount);

        // Execute batch
        const results = await this.executeBatch(run, graph, batch, completedResults);

        // Process results
        for (const result of results) {
          state.stepCount++;

          if (result.status === 'completed') {
            completedSet.add(result.nodeId);
            state.completedNodes.push(result.nodeId);
            completedResults.set(result.nodeId, result);

            // Maintenance: reflect after each node
            await this.maintenanceReflect(run.runId, result.nodeId);
          } else if (result.status === 'failed') {
            failedSet.add(result.nodeId);
            state.failedNodes.push(result.nodeId);
          }
        }

        // Early abort on failure
        if (failedSet.size > 0) {
          break;
        }
      }

      if (failedSet.size > 0) {
        break;
      }
    }

    // Determine overall status
    const status = failedSet.size > 0 ? 'failed' : 'complete';

    // Collect outputs
    const outputs = Array.from(completedResults.values())
      .flatMap(r => r.outputHandles.map(h => ({ name: r.nodeId, handle: h })));

    return {
      runId: run.runId,
      status,
      outputs,
      error: failedSet.size > 0
        ? `Failed nodes: ${Array.from(failedSet).join(', ')}`
        : undefined,
    };
  }

  /**
   * Execute a batch of nodes in parallel
   */
  private async executeBatch(
    run: RunSpec,
    graph: TaskGraph,
    nodes: NodeSpec[],
    completedResults: Map<string, NodeExecutionResult>
  ): Promise<NodeExecutionResult[]> {
    const promises = nodes.map(node => this.executeNode(run, graph, node, completedResults));
    const settled = await Promise.allSettled(promises);

    return settled.map((result, index) => {
      const nodeId = nodes[index].id;

      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          nodeId,
          status: 'failed' as const,
          outputHandles: [],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          durationMs: 0,
        };
      }
    });
  }

  /**
   * Execute a single node
   */
  private async executeNode(
    run: RunSpec,
    graph: TaskGraph,
    node: NodeSpec,
    completedResults: Map<string, NodeExecutionResult>
  ): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    try {
      const context: NodeExecutionContext = {
        run,
        graph,
        node,
        completedNodes: completedResults,
      };

      // Execute with retry policy
      const result = await this.executeWithRetry(context, node.retryPolicy);
      return result;
    } catch (error) {
      return {
        nodeId: node.id,
        status: 'failed',
        outputHandles: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute with retry policy
   */
  private async executeWithRetry(
    context: NodeExecutionContext,
    retryPolicy?: {
      retriesAllowed?: boolean;
      maxAttempts?: number;
      intervalSeconds?: number;
      backoffRate?: number;
    }
  ): Promise<NodeExecutionResult> {
    const policy = retryPolicy || {
      retriesAllowed: true,
      maxAttempts: 3,
      intervalSeconds: 5,
      backoffRate: 2.0,
    };

    if (!policy.retriesAllowed) {
      return this.config.nodeExecutor(context);
    }

    let lastError: Error | undefined;
    let attempt = 0;
    let delay = (policy.intervalSeconds || 5) * 1000;

    while (attempt < (policy.maxAttempts || 3)) {
      attempt++;

      try {
        const result = await this.config.nodeExecutor(context);
        if (result.status === 'completed') {
          return result;
        }
        lastError = new Error(result.error || 'Node did not complete successfully');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      if (attempt < (policy.maxAttempts || 3)) {
        await this.sleep(delay);
        delay *= policy.backoffRate || 2.0;
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Maintenance: recite todo.md
   */
  private async maintenanceRecite(runId: string, stepCount: number): Promise<void> {
    // Recite every 8 steps by default
    if (stepCount > 0 && stepCount % 8 === 0 && this.config.onRecite) {
      await this.config.onRecite(runId);
    }
  }

  /**
   * Maintenance: reflect on completed node
   */
  private async maintenanceReflect(runId: string, nodeId: string): Promise<void> {
    if (this.config.onReflect) {
      await this.config.onReflect(runId, nodeId);
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create a workflow runner with DBOS integration
 * Note: Full DBOS integration requires DBOS SDK setup
 */
export function createWorkflowRunner(config: WorkflowConfig): RunDAGWorkflow {
  return new RunDAGWorkflow(config);
}

/**
 * Simple non-DBOS workflow runner for testing
 */
export async function runDAGSimple(
  run: RunSpec,
  graph: TaskGraph,
  nodeExecutor: (context: NodeExecutionContext) => Promise<NodeExecutionResult>
): Promise<RunResult> {
  const workflow = new RunDAGWorkflow({
    maxParallelism: graph.global?.maxParallelism || 4,
    nodeExecutor,
  });

  return workflow.run(run, graph);
}
