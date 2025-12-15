/**
 * GraphExecutor - Parallel DAG execution with bounded concurrency
 * 
 * Executes nodes in topological order, respecting dependencies.
 * Each node runs in isolation with its own scoped state.
 */

import {
  TaskGraph,
  NodeSpec,
  RunSpec,
  RunResult,
  NodeExecutionState,
  NodeStatus,
} from '../types/index.js';
import { TaskGraphUtils } from './TaskGraph.js';

/**
 * Result of executing a single node
 */
export interface NodeExecutionResult {
  nodeId: string;
  status: NodeStatus;
  outputHandles: string[];
  error?: string;
  durationMs: number;
}

/**
 * Context provided to node executors
 */
export interface NodeExecutionContext {
  run: RunSpec;
  graph: TaskGraph;
  node: NodeSpec;
  completedNodes: Map<string, NodeExecutionResult>;
}

/**
 * Function type for node execution
 */
export type NodeExecutor = (context: NodeExecutionContext) => Promise<NodeExecutionResult>;

/**
 * Configuration for the graph executor
 */
export interface GraphExecutorConfig {
  maxParallelism: number;
  onNodeStart?: (nodeId: string) => void;
  onNodeComplete?: (result: NodeExecutionResult) => void;
  onNodeError?: (nodeId: string, error: Error) => void;
  onBatchStart?: (nodeIds: string[]) => void;
  onBatchComplete?: (results: NodeExecutionResult[]) => void;
}

/**
 * Main graph executor
 */
export class GraphExecutor {
  private config: GraphExecutorConfig;
  private nodeExecutor: NodeExecutor;

  constructor(nodeExecutor: NodeExecutor, config: Partial<GraphExecutorConfig> = {}) {
    this.nodeExecutor = nodeExecutor;
    this.config = {
      maxParallelism: config.maxParallelism || 4,
      onNodeStart: config.onNodeStart,
      onNodeComplete: config.onNodeComplete,
      onNodeError: config.onNodeError,
      onBatchStart: config.onBatchStart,
      onBatchComplete: config.onBatchComplete,
    };
  }

  /**
   * Execute the entire graph
   */
  async execute(run: RunSpec, graph: TaskGraph): Promise<RunResult> {
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

    const maxPar = graph.global?.maxParallelism || this.config.maxParallelism;
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    const completedNodes = new Map<string, NodeExecutionResult>();
    const failedNodes = new Set<string>();

    // Execute until all nodes complete or fail
    while (completedNodes.size + failedNodes.size < graph.nodes.length) {
      // Get ready nodes
      const completedIds = new Set(completedNodes.keys());
      const ready = TaskGraphUtils.getReadyNodes(graph, completedIds)
        .filter(n => !failedNodes.has(n.id));

      if (ready.length === 0) {
        if (failedNodes.size > 0) {
          // Some nodes failed and remaining nodes depend on them
          break;
        }
        throw new Error('Deadlock: no ready nodes but graph incomplete');
      }

      // Sort for deterministic execution order
      const readySorted = [...ready].sort((a, b) => a.id.localeCompare(b.id));

      // Execute in batches with bounded parallelism
      for (let i = 0; i < readySorted.length; i += maxPar) {
        const batch = readySorted.slice(i, i + maxPar);
        const batchIds = batch.map(n => n.id);

        this.config.onBatchStart?.(batchIds);

        // Execute batch in parallel
        const results = await this.executeBatch(run, graph, batch, completedNodes);

        this.config.onBatchComplete?.(results);

        // Process results
        for (const result of results) {
          if (result.status === 'completed') {
            completedNodes.set(result.nodeId, result);
          } else if (result.status === 'failed') {
            failedNodes.add(result.nodeId);
          }
        }

        // Early abort on failure (configurable behavior)
        if (failedNodes.size > 0) {
          break;
        }
      }

      if (failedNodes.size > 0) {
        break;
      }
    }

    // Determine overall status
    const status: 'complete' | 'failed' = failedNodes.size > 0 ? 'failed' : 'complete';

    // Collect outputs from all completed nodes
    const outputs = Array.from(completedNodes.values())
      .flatMap(r => r.outputHandles.map(h => ({ name: r.nodeId, handle: h })));

    return {
      runId: run.runId,
      status,
      outputs,
      error: failedNodes.size > 0 
        ? `Failed nodes: ${Array.from(failedNodes).join(', ')}`
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
    completedNodes: Map<string, NodeExecutionResult>
  ): Promise<NodeExecutionResult[]> {
    // Create promises in deterministic order
    const promises = nodes.map(node => this.executeNode(run, graph, node, completedNodes));

    // Use allSettled for resilience
    const settled = await Promise.allSettled(promises);

    return settled.map((result, index) => {
      const nodeId = nodes[index].id;
      
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        const error = result.reason instanceof Error 
          ? result.reason.message 
          : String(result.reason);
        
        this.config.onNodeError?.(nodeId, result.reason);
        
        return {
          nodeId,
          status: 'failed' as NodeStatus,
          outputHandles: [],
          error,
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
    completedNodes: Map<string, NodeExecutionResult>
  ): Promise<NodeExecutionResult> {
    this.config.onNodeStart?.(node.id);

    const startTime = Date.now();

    try {
      const context: NodeExecutionContext = {
        run,
        graph,
        node,
        completedNodes,
      };

      const result = await this.executeWithRetry(context, node.retryPolicy);
      
      this.config.onNodeComplete?.(result);
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      const result: NodeExecutionResult = {
        nodeId: node.id,
        status: 'failed',
        outputHandles: [],
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };

      this.config.onNodeError?.(node.id, error as Error);
      
      return result;
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
      return this.nodeExecutor(context);
    }

    let lastError: Error | undefined;
    let attempt = 0;
    let delay = (policy.intervalSeconds || 5) * 1000;

    while (attempt < (policy.maxAttempts || 3)) {
      attempt++;

      try {
        const startTime = Date.now();
        const result = await this.nodeExecutor(context);
        
        if (result.status === 'completed') {
          return result;
        }

        // Treat as failure if not completed
        lastError = new Error(result.error || 'Node did not complete successfully');
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // Wait before retry (except on last attempt)
      if (attempt < (policy.maxAttempts || 3)) {
        await this.sleep(delay);
        delay *= policy.backoffRate || 2.0;
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create a simple node executor for testing
 */
export function createMockNodeExecutor(
  handler: (context: NodeExecutionContext) => Promise<string[]>
): NodeExecutor {
  return async (context: NodeExecutionContext): Promise<NodeExecutionResult> => {
    const startTime = Date.now();
    
    try {
      const outputHandles = await handler(context);
      
      return {
        nodeId: context.node.id,
        status: 'completed',
        outputHandles,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        nodeId: context.node.id,
        status: 'failed',
        outputHandles: [],
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  };
}
