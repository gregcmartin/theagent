/**
 * Agentic Harness Framework
 * 
 * A TypeScript framework for building long-running AI agents with:
 * - Memory-first, context-compiled architecture
 * - Skills-first runtime with progressive disclosure
 * - DAG orchestration with parallel execution
 * - DBOS durable workflows
 * - Self-improving via reflection and curation
 */

// Core Types
export * from './packages/core/types/index.js';

// Memory Stores
export {
  ArtifactStore,
  SessionStore,
  MemoryStore,
  PlaybookStore,
  type ArtifactStoreConfig,
  type SessionStoreConfig,
  type MemoryStoreConfig,
  type PlaybookStoreConfig,
  type EventQuery,
  type MemoryCategory,
  type MemoryQuery,
  type MemoryHit,
  type PlaybookFile,
  type PlaybookBullet,
} from './packages/core/memory/index.js';

// Context Compiler
export {
  ContextCompiler,
  ContextBuilder,
  type CompileInput,
  type ContextProcessor,
} from './packages/core/context/ContextCompiler.js';

// DAG Orchestration
export {
  TaskGraphBuilder,
  NodeBuilder,
  TaskGraphUtils,
  GraphExecutor,
  GraphPlanner,
  createMockNodeExecutor,
  type NodeExecutionResult,
  type NodeExecutionContext,
  type NodeExecutor,
  type GraphExecutorConfig,
  type PlannerLLMProvider,
  type GraphPlannerConfig,
  type PlanResult,
} from './packages/core/dag/index.js';

// Skills System
export {
  SkillRegistry,
  SkillLoader,
  createDefaultSkills,
  type SkillRegistryConfig,
  type Skill,
  type SkillLoaderConfig,
  type LoadedSkills,
} from './packages/skills/index.js';

// Maintenance
export {
  MaintenanceManager,
  Compactor,
  Reciter,
  Reflector,
  Curator,
  type MaintenanceConfig,
  type MaintenanceLLMProvider,
} from './packages/core/maintenance/Maintenance.js';

// Orchestrator
export {
  Orchestrator,
  createOrchestrator,
  type LLMProvider,
  type OrchestratorConfig,
} from './packages/core/orchestrator/Orchestrator.js';

// Anthropic Provider
export {
  AnthropicProvider,
  createMockAnthropicProvider,
  type AnthropicProviderConfig,
} from './packages/providers/anthropic/AnthropicProvider.js';

// Workflows
export {
  RunDAGWorkflow,
  createWorkflowRunner,
  runDAGSimple,
  type WorkflowConfig,
} from './packages/workflows/dbos/RunDAGWorkflow.js';

/**
 * Quick start function to create and run an agent
 */
export async function quickStart(
  objective: string,
  options: {
    basePath?: string;
    anthropicApiKey?: string;
  } = {}
): Promise<void> {
  const { AnthropicProvider } = await import('./packages/providers/anthropic/AnthropicProvider.js');
  const { Orchestrator } = await import('./packages/core/orchestrator/Orchestrator.js');

  const basePath = options.basePath || './agent_data';
  
  const llmProvider = new AnthropicProvider({
    apiKey: options.anthropicApiKey,
  });

  const orchestrator = new Orchestrator({
    basePath,
    llmProvider,
  });

  console.log(`\n🚀 Starting agent with objective: ${objective}\n`);

  const result = await orchestrator.run(objective);

  console.log(`\n✅ Run completed with status: ${result.status}`);
  console.log(`📁 Outputs: ${result.outputs.length} artifacts`);
  
  if (result.error) {
    console.log(`❌ Error: ${result.error}`);
  }

  console.log(`\n📂 Data stored in: ${basePath}`);
}

// CLI entry point
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('index.js')) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Agentic Harness Framework

Usage:
  node dist/index.js <objective>

Example:
  node dist/index.js "Analyze the current directory and create a summary"

Environment:
  ANTHROPIC_API_KEY - Your Anthropic API key

Options:
  --base-path <path>  - Directory to store agent data (default: ./agent_data)
`);
  } else {
    const objective = args.filter(a => !a.startsWith('--')).join(' ');
    const basePath = args.find((a, i) => args[i - 1] === '--base-path') || './agent_data';

    quickStart(objective, { basePath }).catch(console.error);
  }
}
