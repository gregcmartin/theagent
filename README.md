# 🤖 TheAgent - Agentic Harness Framework

A TypeScript framework for building long-running, self-improving AI agents with robust memory management, DAG-based task orchestration, and durable workflows.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Features

- **🧠 Memory-First Architecture** - Persistent storage for facts, tactics, and learned strategies
- **📊 DAG Orchestration** - Parallel task execution with dependency management
- **🔄 Self-Improving** - Reflection and curation loops for continuous learning
- **💾 Durable Workflows** - DBOS integration for crash recovery and checkpointing
- **🎯 Skills System** - Progressive disclosure with on-demand loading
- **📝 Context Compilation** - ADK-style processor pipeline for optimal LLM prompts

## 🚀 Quick Start

### Installation

```bash
git clone https://github.com/gregcmartin/theagent.git
cd theagent
npm install
npm run build
```

### Usage

```bash
# Set your Anthropic API key
export ANTHROPIC_API_KEY="your-api-key"

# Run a task
node dist/index.js "Your task objective here"

# Example
node dist/index.js "Create a Python script that analyzes CSV files"
```

### Programmatic Usage

```typescript
import { Orchestrator, AnthropicProvider } from 'agentic-harness';

const provider = new AnthropicProvider();
const orchestrator = new Orchestrator({
  basePath: './agent_data',
  llmProvider: provider,
});

const result = await orchestrator.run('Build a REST API for todo items');
console.log(result);
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                           │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ GraphPlanner │  │GraphExecutor │  │ Maintenance  │      │
│  │   (LLM)      │  │  (Parallel)  │  │   Loops      │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Context    │  │    Skills    │  │   Anthropic  │      │
│  │  Compiler    │  │   Registry   │  │   Provider   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Artifact    │  │   Session    │  │   Memory     │      │
│  │   Store      │  │    Store     │  │    Store     │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
src/
├── index.ts                  # Entry point & CLI
└── packages/
    ├── core/
    │   ├── types/            # Zod schemas for all data structures
    │   ├── memory/           # Artifact, Session, Memory, Playbook stores
    │   ├── context/          # ADK-style context compiler
    │   ├── dag/              # TaskGraph, Planner, Executor
    │   ├── maintenance/      # Compaction, Recitation, Reflection, Curation
    │   └── orchestrator/     # Main coordination layer
    ├── providers/
    │   └── anthropic/        # Claude API integration
    ├── skills/               # Skill registry and loader
    └── workflows/
        └── dbos/             # Durable workflow support
```

## 🔧 Core Concepts

### Task Graph (DAG)

Tasks are decomposed into a directed acyclic graph of nodes:

```typescript
const graph = new TaskGraphBuilder('Build a website', 'run_123')
  .node('plan', 'plan', 'Create project structure')
    .namespace('runs/run_123/nodes/plan')
    .acceptance('a1', 'checks', 'Structure defined')
    .add()
  .node('code', 'execute', 'Write the code')
    .deps('plan')
    .acceptance('a2', 'checks', 'Code compiles')
    .add()
  .build();
```

### Node Types

| Type | Purpose |
|------|---------|
| `plan` | Decompose objectives into sub-tasks |
| `research` | Gather information and analyze data |
| `execute` | Perform actions and create artifacts |
| `synthesize` | Combine results from multiple nodes |
| `verify` | Validate outputs against criteria |
| `curate` | Produce memory deltas and playbook diffs |
| `commit` | Finalize and merge staged updates |

### Memory Stores

- **ArtifactStore** - Pointer-first blob storage with content hashing
- **SessionStore** - Append-only event logs with compaction
- **MemoryStore** - Long-lived facts, tactics, and pitfalls
- **PlaybookStore** - Self-improving strategy documents

### Context Compiler

Every LLM call is built from a fresh compiled view using 9 processors:

1. **PrefixProcessor** - Stable identity and rules
2. **ScopeProcessor** - Node objective and acceptance criteria
3. **RetrievalProcessor** - Relevant memory retrieval
4. **ArtifactPointerProcessor** - References (not content)
5. **SkillIndexProcessor** - Available skill metadata
6. **SkillLoadProcessor** - Full skill content on demand
7. **RecitationProcessor** - Current plan and todo
8. **CompactionGuardProcessor** - Token budget management
9. **TaskMessageProcessor** - The actual task prompt

## 🛠️ CLI Commands

```bash
# Run a task
node dist/index.js "Your objective"

# Specify data directory
node dist/index.js --base-path ./custom_data "Your objective"

# Clean up run data
./cleanup.sh                # Remove all data
./cleanup.sh --keep-playbook  # Keep learned strategies
./cleanup.sh --keep-skills    # Keep custom skills
```

## 📊 Data Storage

Run data is stored in `./agent_data/`:

```
agent_data/
├── artifacts/    # Generated files and outputs
├── sessions/     # Event logs (JSONL)
├── memory/       # Facts, tactics, pitfalls
├── playbook/     # Learned strategies
└── skills/       # Custom skill definitions
```

## 🔐 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Yes |

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📚 Documentation

For detailed documentation, see the `Notes.md` file which contains:
- Complete schema definitions
- DBOS workflow integration details
- Architecture design decisions

---

Built with ❤️ using TypeScript and Claude
