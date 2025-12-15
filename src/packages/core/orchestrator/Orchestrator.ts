/**
 * Orchestrator - Main entry point for the Agentic Harness Framework
 * 
 * Coordinates all components:
 * - Stores (Session, Memory, Artifact, Playbook)
 * - Context Compiler
 * - Skills System
 * - DAG Planner and Executor
 * - Maintenance Loops
 * - LLM Provider
 */

import { v4 as uuidv4 } from 'uuid';
import {
  RunSpec,
  TaskGraph,
  RunResult,
  NodeSpec,
  CompiledContext,
  SkillMeta,
} from '../types/index.js';
import { SessionStore } from '../memory/SessionStore.js';
import { ArtifactStore } from '../memory/ArtifactStore.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { PlaybookStore } from '../memory/PlaybookStore.js';
import { ContextCompiler, CompileInput } from '../context/ContextCompiler.js';
import { GraphPlanner, PlannerLLMProvider } from '../dag/GraphPlanner.js';
import { GraphExecutor, NodeExecutionContext, NodeExecutionResult } from '../dag/GraphExecutor.js';
import { TaskGraphBuilder } from '../dag/TaskGraph.js';
import {
  MaintenanceManager,
  Compactor,
  Reciter,
  Reflector,
  Curator,
} from '../maintenance/Maintenance.js';
import { SkillRegistry } from '../../skills/SkillRegistry.js';
import { SkillLoader, createDefaultSkills } from '../../skills/SkillLoader.js';

/**
 * LLM Provider interface
 */
export interface LLMProvider {
  complete(context: CompiledContext, opts: { maxTokens: number }): Promise<string>;
}

/**
 * Configuration for the orchestrator
 */
export interface OrchestratorConfig {
  basePath: string;
  llmProvider: LLMProvider;
  maxParallelism?: number;
  reciteEverySteps?: number;
  reflectEveryNodes?: number;
  compactWhenTokenUsagePct?: number;
}

/**
 * Main Orchestrator class
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  
  // Stores
  private sessionStore: SessionStore;
  private artifactStore: ArtifactStore;
  private memoryStore: MemoryStore;
  private playbookStore: PlaybookStore;
  
  // Components
  private contextCompiler: ContextCompiler;
  private skillRegistry: SkillRegistry;
  private skillLoader: SkillLoader;
  private graphPlanner: GraphPlanner;
  private graphExecutor: GraphExecutor;
  private maintenanceManager: MaintenanceManager;
  
  // Maintenance components
  private compactor: Compactor;
  private reciter: Reciter;
  private reflector: Reflector;
  private curator: Curator;

  private initialized: boolean = false;

  constructor(config: OrchestratorConfig) {
    this.config = config;

    // Initialize stores
    this.sessionStore = new SessionStore({ basePath: `${config.basePath}/sessions` });
    this.artifactStore = new ArtifactStore({ basePath: `${config.basePath}/artifacts` });
    this.memoryStore = new MemoryStore({ basePath: `${config.basePath}/memory` });
    this.playbookStore = new PlaybookStore({ basePath: `${config.basePath}/playbook` });

    // Initialize context compiler
    this.contextCompiler = new ContextCompiler();

    // Initialize skill system
    this.skillRegistry = new SkillRegistry({ skillsPath: `${config.basePath}/skills` });
    this.skillLoader = new SkillLoader({ registry: this.skillRegistry });

    // Initialize planner
    this.graphPlanner = new GraphPlanner({
      llmProvider: config.llmProvider,
      skillIndex: [],
      artifactStore: this.artifactStore,
    });

    // Initialize executor with node execution function
    this.graphExecutor = new GraphExecutor(
      (ctx) => this.executeNode(ctx),
      { maxParallelism: config.maxParallelism || 4 }
    );

    // Initialize maintenance components
    this.compactor = new Compactor(this.sessionStore, this.artifactStore, config.llmProvider);
    this.reciter = new Reciter(this.artifactStore);
    this.reflector = new Reflector(this.artifactStore, config.llmProvider);
    this.curator = new Curator(this.artifactStore, this.memoryStore, this.playbookStore, config.llmProvider);

    // Initialize maintenance manager
    this.maintenanceManager = new MaintenanceManager({
      sessionStore: this.sessionStore,
      artifactStore: this.artifactStore,
      memoryStore: this.memoryStore,
      playbookStore: this.playbookStore,
      llmProvider: config.llmProvider,
      reciteEverySteps: config.reciteEverySteps || 8,
      reflectEveryNodes: config.reflectEveryNodes || 1,
      compactWhenTokenUsagePct: config.compactWhenTokenUsagePct || 0.75,
    });
  }

  /**
   * Initialize all stores and components
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    await this.sessionStore.init();
    await this.artifactStore.init();
    await this.memoryStore.init();
    await this.playbookStore.init();
    await this.skillRegistry.init();

    // Create default skills
    await createDefaultSkills(this.skillRegistry);

    this.initialized = true;
  }

  /**
   * Run a task with a given objective
   */
  async run(objective: string, input?: Record<string, unknown>): Promise<RunResult> {
    await this.init();

    const runId = `run_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const run: RunSpec = { runId, objective, input };

    // Log run start
    await this.sessionStore.appendEvent({
      runId,
      type: 'run_started',
      payload: { objective, input },
    });

    try {
      // Plan the graph
      const skillIndex = await this.skillRegistry.listMetadata();
      this.graphPlanner = new GraphPlanner({
        llmProvider: this.config.llmProvider,
        skillIndex,
        artifactStore: this.artifactStore,
      });

      const planResult = await this.graphPlanner.plan(run);
      
      // Log plan created
      await this.sessionStore.appendEvent({
        runId,
        type: 'plan_created',
        refs: [planResult.todoArtifactHandle],
        payload: { nodeCount: planResult.graph.nodes.length },
      });

      // Execute the graph
      const result = await this.graphExecutor.execute(run, planResult.graph);

      // Log run completed
      await this.sessionStore.appendEvent({
        runId,
        type: result.status === 'complete' ? 'run_completed' : 'run_failed',
        payload: { status: result.status, error: result.error },
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.sessionStore.appendEvent({
        runId,
        type: 'run_failed',
        payload: { error: errorMessage },
      });

      return {
        runId,
        status: 'failed',
        outputs: [],
        error: errorMessage,
      };
    }
  }

  /**
   * Run with a pre-defined graph
   */
  async runWithGraph(run: RunSpec, graph: TaskGraph): Promise<RunResult> {
    await this.init();

    await this.sessionStore.appendEvent({
      runId: run.runId,
      type: 'run_started',
      payload: { objective: run.objective, nodeCount: graph.nodes.length },
    });

    try {
      const result = await this.graphExecutor.execute(run, graph);

      await this.sessionStore.appendEvent({
        runId: run.runId,
        type: result.status === 'complete' ? 'run_completed' : 'run_failed',
        payload: { status: result.status, error: result.error },
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.sessionStore.appendEvent({
        runId: run.runId,
        type: 'run_failed',
        payload: { error: errorMessage },
      });

      return {
        runId: run.runId,
        status: 'failed',
        outputs: [],
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a single node
   */
  private async executeNode(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const { run, graph, node, completedNodes } = context;
    const startTime = Date.now();

    try {
      // Log node start
      await this.sessionStore.appendEvent({
        runId: run.runId,
        nodeId: node.id,
        type: 'node_started',
        payload: { objective: node.objective, type: node.type },
      });

      // Build context for the node
      const compileInput = await this.buildCompileInput(run, graph, node, completedNodes);
      const compiledContext = await this.contextCompiler.compile(compileInput);

      // Execute via LLM
      const response = await this.config.llmProvider.complete(compiledContext, {
        maxTokens: node.budgets?.maxTokens || 4000,
      });

      // Parse and store outputs
      const outputHandles = await this.processNodeResponse(run, node, response);

      // Record step for maintenance
      this.maintenanceManager.recordStep();

      // Check if maintenance is needed
      if (this.maintenanceManager.shouldRecite()) {
        await this.reciter.recite(
          run,
          graph,
          new Set([...completedNodes.keys()]),
          node.id
        );
      }

      // Log node complete
      await this.sessionStore.appendEvent({
        runId: run.runId,
        nodeId: node.id,
        type: 'node_completed',
        refs: outputHandles,
        payload: { durationMs: Date.now() - startTime },
      });

      // Record node completion for maintenance
      this.maintenanceManager.recordNodeComplete();

      // Reflect if needed
      if (this.maintenanceManager.shouldReflect()) {
        const reflection = await this.reflector.reflect(run, node, [], []);
        await this.curator.curate(run, node, reflection);
      }

      return {
        nodeId: node.id,
        status: 'completed',
        outputHandles,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.sessionStore.appendEvent({
        runId: run.runId,
        nodeId: node.id,
        type: 'node_failed',
        payload: { error: errorMessage, durationMs: Date.now() - startTime },
      });

      return {
        nodeId: node.id,
        status: 'failed',
        outputHandles: [],
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Build compile input for a node
   */
  private async buildCompileInput(
    run: RunSpec,
    graph: TaskGraph,
    node: NodeSpec,
    completedNodes: Map<string, NodeExecutionResult>
  ): Promise<CompileInput> {
    // Get skill metadata
    const skillIndex = await this.skillRegistry.listMetadata();

    // Load skills based on hints
    const loadedSkillsResult = await this.skillLoader.loadForNode(
      node.skillHints || [],
      node.scope.allowedSkills
    );

    // Get memory hits
    const memoryHits = await this.memoryStore.retrieve({
      query: node.objective,
      k: 5,
    });

    // Get artifact pointers from completed dependencies
    const artifactPointers = [];
    for (const depId of node.deps) {
      const depResult = completedNodes.get(depId);
      if (depResult) {
        for (const handle of depResult.outputHandles) {
          const meta = await this.artifactStore.getMetadata(handle);
          if (meta) {
            artifactPointers.push(meta);
          }
        }
      }
    }

    // Get todo.md content
    let todoMarkdown = '';
    try {
      todoMarkdown = await this.artifactStore.getText(`runs/${run.runId}/nodes/plan/todo.md`);
    } catch {
      todoMarkdown = `# TODO: ${run.objective}\n\nExecuting: ${node.objective}`;
    }

    return {
      run,
      node,
      skillIndex,
      loadedSkills: loadedSkillsResult.loaded,
      memoryHits,
      artifactPointers,
      todoMarkdown,
    };
  }

  /**
   * Process node response and extract outputs
   */
  private async processNodeResponse(
    run: RunSpec,
    node: NodeSpec,
    response: string
  ): Promise<string[]> {
    const handles: string[] = [];

    // Store the raw response
    const responseHandle = await this.artifactStore.putText(
      node.scope.artifactNamespace,
      'response.txt',
      response,
      { tags: ['response', node.type], shortSummary: `Response for ${node.id}` }
    );
    handles.push(responseHandle.uri);

    // Try to extract JSON from the response
    try {
      const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        const jsonContent = JSON.parse(jsonMatch[1]);
        const jsonHandle = await this.artifactStore.putJson(
          node.scope.artifactNamespace,
          'output.json',
          jsonContent,
          { tags: ['output', node.type], shortSummary: `Output for ${node.id}` }
        );
        handles.push(jsonHandle.uri);
      }
    } catch {
      // No JSON to extract
    }

    return handles;
  }

  /**
   * Get the artifact store
   */
  getArtifactStore(): ArtifactStore {
    return this.artifactStore;
  }

  /**
   * Get the memory store
   */
  getMemoryStore(): MemoryStore {
    return this.memoryStore;
  }

  /**
   * Get the session store
   */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  /**
   * Get the playbook store
   */
  getPlaybookStore(): PlaybookStore {
    return this.playbookStore;
  }

  /**
   * Get the skill registry
   */
  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }
}

/**
 * Create and initialize an orchestrator
 */
export async function createOrchestrator(config: OrchestratorConfig): Promise<Orchestrator> {
  const orchestrator = new Orchestrator(config);
  await orchestrator.init();
  return orchestrator;
}
