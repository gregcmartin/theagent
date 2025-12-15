/**
 * TaskGraph - DAG structure for task orchestration
 * 
 * Represents the execution plan as a directed acyclic graph.
 * Nodes include objectives, dependencies, acceptance tests, and scope rules.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  TaskGraph,
  TaskGraphSchema,
  NodeSpec,
  NodeSpecSchema,
  NodeType,
  Scope,
  IOContract,
  AcceptanceTest,
  Constraint,
  GlobalConfig,
} from '../types/index.js';

/**
 * Builder for creating TaskGraphs
 */
export class TaskGraphBuilder {
  private runId: string;
  private objective: string;
  private constraints: Constraint[] = [];
  private global: Partial<GlobalConfig> = {};
  private nodes: NodeSpec[] = [];

  constructor(objective: string, runId?: string) {
    this.objective = objective;
    this.runId = runId || `run_${Date.now()}_${uuidv4().substring(0, 8)}`;
  }

  /**
   * Add a constraint to the graph
   */
  addConstraint(id: string, text: string, strength: 'hard' | 'soft' = 'hard'): this {
    this.constraints.push({ id, text, strength });
    return this;
  }

  /**
   * Set global configuration
   */
  setGlobalConfig(config: Partial<GlobalConfig>): this {
    this.global = { ...this.global, ...config };
    return this;
  }

  /**
   * Add a node to the graph
   */
  addNode(node: NodeSpec): this {
    this.nodes.push(NodeSpecSchema.parse(node));
    return this;
  }

  /**
   * Create a node builder for easier node construction
   */
  node(id: string, type: NodeType, objective: string): NodeBuilder {
    return new NodeBuilder(this, id, type, objective);
  }

  /**
   * Build the final TaskGraph
   */
  build(): TaskGraph {
    return TaskGraphSchema.parse({
      version: '1.0',
      runId: this.runId,
      objective: this.objective,
      constraints: this.constraints,
      global: this.global,
      nodes: this.nodes,
    });
  }
}

/**
 * Builder for creating individual nodes
 */
export class NodeBuilder {
  private graphBuilder: TaskGraphBuilder;
  private node: Partial<NodeSpec>;

  constructor(
    graphBuilder: TaskGraphBuilder,
    id: string,
    type: NodeType,
    objective: string
  ) {
    this.graphBuilder = graphBuilder;
    this.node = {
      id,
      type,
      objective,
      deps: [],
      skillHints: [],
      scope: {
        artifactNamespace: '',
        artifactPolicy: {
          allowReadsFrom: [],
          writeMode: 'scopedOnly',
          pointerFirst: true,
        },
        memoryWritePolicy: 'stageDeltaOnly',
        sessionVisibility: 'ownPlusDeps',
        allowedSkills: [],
      },
      io: { inputs: [], outputs: [] },
      acceptance: [],
    };
  }

  /**
   * Set dependencies
   */
  deps(...nodeIds: string[]): this {
    this.node.deps = nodeIds;
    return this;
  }

  /**
   * Add skill hints
   */
  skillHints(...skills: string[]): this {
    this.node.skillHints = skills;
    return this;
  }

  /**
   * Set the scope
   */
  scope(scope: Partial<Scope>): this {
    this.node.scope = { ...this.node.scope!, ...scope } as Scope;
    return this;
  }

  /**
   * Set artifact namespace (convenience method)
   */
  namespace(namespace: string): this {
    this.node.scope!.artifactNamespace = namespace;
    return this;
  }

  /**
   * Set allowed reads from other namespaces
   */
  allowReadsFrom(...namespaces: string[]): this {
    this.node.scope!.artifactPolicy!.allowReadsFrom = namespaces;
    return this;
  }

  /**
   * Set memory write policy
   */
  memoryPolicy(policy: 'deny' | 'stageDeltaOnly' | 'curatorOnly'): this {
    this.node.scope!.memoryWritePolicy = policy;
    return this;
  }

  /**
   * Add input artifacts
   */
  inputs(...inputs: Array<{ name: string; type: string; description?: string }>): this {
    this.node.io!.inputs = inputs.map(i => ({
      name: i.name,
      type: i.type as any,
      description: i.description || '',
    }));
    return this;
  }

  /**
   * Add output artifacts
   */
  outputs(...outputs: Array<{ name: string; type: string; description?: string }>): this {
    this.node.io!.outputs = outputs.map(o => ({
      name: o.name,
      type: o.type as any,
      description: o.description || '',
    }));
    return this;
  }

  /**
   * Add an acceptance test
   */
  acceptance(
    id: string,
    type: 'schema' | 'checks' | 'humanReview' | 'unitTests',
    criteria: string,
    requiresArtifacts: string[] = []
  ): this {
    this.node.acceptance!.push({ id, type, criteria, requiresArtifacts });
    return this;
  }

  /**
   * Set budgets
   */
  budgets(maxSteps?: number, maxTokens?: number): this {
    this.node.budgets = {
      maxSteps: maxSteps || 20,
      maxTokens: maxTokens || 12000,
    };
    return this;
  }

  /**
   * Set retry policy
   */
  retryPolicy(
    maxAttempts: number = 3,
    intervalSeconds: number = 5,
    backoffRate: number = 2.0
  ): this {
    this.node.retryPolicy = {
      retriesAllowed: true,
      maxAttempts,
      intervalSeconds,
      backoffRate,
    };
    return this;
  }

  /**
   * Add the node to the graph and return the graph builder
   */
  add(): TaskGraphBuilder {
    this.graphBuilder.addNode(this.node as NodeSpec);
    return this.graphBuilder;
  }
}

/**
 * Utilities for working with TaskGraphs
 */
export class TaskGraphUtils {
  /**
   * Validate a TaskGraph structure
   */
  static validate(graph: TaskGraph): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const nodeIds = new Set(graph.nodes.map(n => n.id));

    // Check for duplicate node IDs
    if (nodeIds.size !== graph.nodes.length) {
      errors.push('Duplicate node IDs detected');
    }

    // Check that all dependencies exist
    for (const node of graph.nodes) {
      for (const dep of node.deps) {
        if (!nodeIds.has(dep)) {
          errors.push(`Node ${node.id} depends on non-existent node ${dep}`);
        }
      }
    }

    // Check for cycles
    const cycleCheck = TaskGraphUtils.detectCycles(graph);
    if (cycleCheck.hasCycle) {
      errors.push(`Cycle detected: ${cycleCheck.cycle?.join(' -> ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Detect cycles in the graph using DFS
   */
  static detectCycles(graph: TaskGraph): { hasCycle: boolean; cycle?: string[] } {
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (nodeId: string): boolean => {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const node = nodeMap.get(nodeId);
      if (node) {
        for (const dep of node.deps) {
          if (!visited.has(dep)) {
            if (dfs(dep)) return true;
          } else if (recursionStack.has(dep)) {
            path.push(dep);
            return true;
          }
        }
      }

      path.pop();
      recursionStack.delete(nodeId);
      return false;
    };

    for (const node of graph.nodes) {
      if (!visited.has(node.id)) {
        if (dfs(node.id)) {
          return { hasCycle: true, cycle: path };
        }
      }
    }

    return { hasCycle: false };
  }

  /**
   * Get topological order of nodes
   */
  static getTopologicalOrder(graph: TaskGraph): string[] {
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    const inDegree = new Map<string, number>();
    const order: string[] = [];

    // Initialize in-degrees
    for (const node of graph.nodes) {
      if (!inDegree.has(node.id)) {
        inDegree.set(node.id, 0);
      }
      for (const dep of node.deps) {
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
      }
    }

    // Start with nodes that have no dependencies
    const queue = graph.nodes.filter(n => (inDegree.get(n.id) || 0) === 0).map(n => n.id);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      order.push(nodeId);

      // Reduce in-degree of nodes that depend on this one
      for (const node of graph.nodes) {
        if (node.deps.includes(nodeId)) {
          inDegree.set(node.id, (inDegree.get(node.id) || 1) - 1);
          if (inDegree.get(node.id) === 0) {
            queue.push(node.id);
          }
        }
      }
    }

    return order;
  }

  /**
   * Get nodes that are ready to execute (all deps completed)
   */
  static getReadyNodes(graph: TaskGraph, completedNodeIds: Set<string>): NodeSpec[] {
    return graph.nodes.filter(node => {
      if (completedNodeIds.has(node.id)) return false;
      return node.deps.every(dep => completedNodeIds.has(dep));
    });
  }

  /**
   * Get all dependencies of a node (transitive)
   */
  static getTransitiveDeps(graph: TaskGraph, nodeId: string): string[] {
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
    const deps = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const node = nodeMap.get(currentId);
      if (node) {
        for (const dep of node.deps) {
          if (!deps.has(dep)) {
            deps.add(dep);
            queue.push(dep);
          }
        }
      }
    }

    return Array.from(deps);
  }

  /**
   * Serialize a TaskGraph to JSON
   */
  static toJSON(graph: TaskGraph): string {
    return JSON.stringify(graph, null, 2);
  }

  /**
   * Parse a TaskGraph from JSON
   */
  static fromJSON(json: string): TaskGraph {
    return TaskGraphSchema.parse(JSON.parse(json));
  }
}
