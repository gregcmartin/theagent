/**
 * SkillLoader - Progressive skill loading for context compilation
 * 
 * Handles the progressive disclosure pattern:
 * - Preload only metadata into prompts
 * - Load full content only when skills are selected
 */

import { SkillMeta } from '../core/types/index.js';
import { SkillRegistry, Skill } from './SkillRegistry.js';

/**
 * Configuration for skill loading
 */
export interface SkillLoaderConfig {
  registry: SkillRegistry;
  maxLoadedSkills?: number;
  maxSkillContentLength?: number;
}

/**
 * Result of loading skills for a node
 */
export interface LoadedSkills {
  metadata: SkillMeta[];
  loaded: string[];
  truncated: boolean;
}

/**
 * Skill Loader for progressive disclosure
 */
export class SkillLoader {
  private registry: SkillRegistry;
  private maxLoadedSkills: number;
  private maxSkillContentLength: number;

  constructor(config: SkillLoaderConfig) {
    this.registry = config.registry;
    this.maxLoadedSkills = config.maxLoadedSkills || 5;
    this.maxSkillContentLength = config.maxSkillContentLength || 4000;
  }

  /**
   * Get all skill metadata (for the skill index processor)
   */
  async getAllMetadata(): Promise<SkillMeta[]> {
    return this.registry.listMetadata();
  }

  /**
   * Load skills for a node based on hints and allowed skills
   */
  async loadForNode(
    skillHints: string[],
    allowedSkills: string[]
  ): Promise<LoadedSkills> {
    const allMetadata = await this.registry.listMetadata();
    
    // Filter to allowed skills if specified
    const availableMetadata = allowedSkills.length > 0
      ? allMetadata.filter(m => 
          allowedSkills.includes(m.id) || 
          allowedSkills.includes(m.name) ||
          allowedSkills.some(a => m.tags.includes(a))
        )
      : allMetadata;

    // Determine which skills to load based on hints
    const skillsToLoad: string[] = [];
    
    for (const hint of skillHints) {
      // Exact match by ID
      const exactMatch = availableMetadata.find(m => 
        m.id === hint || m.name === hint
      );
      if (exactMatch) {
        skillsToLoad.push(exactMatch.id);
        continue;
      }

      // Tag match
      const tagMatch = availableMetadata.find(m => 
        m.tags.includes(hint)
      );
      if (tagMatch) {
        skillsToLoad.push(tagMatch.id);
      }
    }

    // Deduplicate and limit
    const uniqueSkills = [...new Set(skillsToLoad)].slice(0, this.maxLoadedSkills);

    // Load the skill content
    const loaded: string[] = [];
    let truncated = false;
    let totalLength = 0;

    for (const skillId of uniqueSkills) {
      try {
        const content = await this.registry.loadSkillMarkdown(skillId);
        
        if (totalLength + content.length > this.maxSkillContentLength) {
          truncated = true;
          // Try to include a truncated version
          const remaining = this.maxSkillContentLength - totalLength;
          if (remaining > 500) {
            loaded.push(content.substring(0, remaining) + '\n\n... (truncated)');
          }
          break;
        }

        loaded.push(content);
        totalLength += content.length;
      } catch {
        // Skip skills that fail to load
      }
    }

    return {
      metadata: availableMetadata,
      loaded,
      truncated,
    };
  }

  /**
   * Search and load relevant skills based on objective
   */
  async loadRelevantSkills(
    objective: string,
    maxSkills: number = 3
  ): Promise<LoadedSkills> {
    // Search skills by objective keywords
    const words = objective.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    const allMetadata = await this.registry.listMetadata();
    const scored: Array<{ meta: SkillMeta; score: number }> = [];

    for (const meta of allMetadata) {
      let score = 0;
      const searchText = `${meta.name} ${meta.description} ${meta.tags.join(' ')}`.toLowerCase();
      
      for (const word of words) {
        if (searchText.includes(word)) {
          score++;
        }
      }

      if (score > 0) {
        scored.push({ meta, score });
      }
    }

    // Sort by score and take top matches
    scored.sort((a, b) => b.score - a.score);
    const topSkills = scored.slice(0, maxSkills).map(s => s.meta.id);

    // Load the selected skills
    const loaded: string[] = [];
    let totalLength = 0;
    let truncated = false;

    for (const skillId of topSkills) {
      try {
        const content = await this.registry.loadSkillMarkdown(skillId);
        
        if (totalLength + content.length > this.maxSkillContentLength) {
          truncated = true;
          break;
        }

        loaded.push(content);
        totalLength += content.length;
      } catch {
        // Skip skills that fail to load
      }
    }

    return {
      metadata: allMetadata,
      loaded,
      truncated,
    };
  }

  /**
   * Format loaded skills for injection into context
   */
  formatForContext(loadedSkills: LoadedSkills): string {
    const parts: string[] = [];

    // Metadata index
    parts.push('## Available Skills\n');
    for (const meta of loadedSkills.metadata) {
      const tags = meta.tags.length > 0 ? ` [${meta.tags.join(', ')}]` : '';
      parts.push(`- **${meta.name}**: ${meta.description}${tags}`);
    }

    // Loaded content
    if (loadedSkills.loaded.length > 0) {
      parts.push('\n## Loaded Skill Details\n');
      for (const content of loadedSkills.loaded) {
        parts.push(content);
        parts.push('\n---\n');
      }
    }

    if (loadedSkills.truncated) {
      parts.push('\n*Note: Some skill content was truncated due to context limits.*');
    }

    return parts.join('\n');
  }

  /**
   * Load a specific skill by ID
   */
  async loadSkill(skillId: string): Promise<Skill | null> {
    return this.registry.loadSkill(skillId);
  }

  /**
   * Get the underlying registry
   */
  getRegistry(): SkillRegistry {
    return this.registry;
  }
}

/**
 * Create default built-in skills
 */
export async function createDefaultSkills(registry: SkillRegistry): Promise<void> {
  // Planning skill
  await registry.registerSkill(
    'planning',
    'planning',
    'Create execution plans and decompose objectives into actionable steps',
    `## When to Use

Use this skill when you need to:
- Break down a complex objective into smaller tasks
- Create a DAG of dependent tasks
- Define acceptance criteria for each task

## Procedure

1. Analyze the objective to understand the end goal
2. Identify major phases or milestones
3. Break each phase into concrete tasks
4. Determine dependencies between tasks
5. Define acceptance criteria for each task
6. Estimate effort and identify risks

## Output Format

Produce a TaskGraph JSON with:
- nodes: Array of task specifications
- constraints: Any requirements or limits

## Tips

- Maximize parallelism where possible
- Keep tasks focused and testable
- Include verification steps
`,
    ['planning', 'dag', 'decomposition']
  );

  // Research skill
  await registry.registerSkill(
    'research',
    'research',
    'Gather and analyze information from various sources',
    `## When to Use

Use this skill when you need to:
- Collect information about a topic
- Analyze data or documents
- Synthesize findings into insights

## Procedure

1. Define the research question or goal
2. Identify potential sources
3. Collect relevant information
4. Analyze and cross-reference findings
5. Produce a structured summary

## Output Format

Produce artifacts with:
- findings.json: Structured findings
- evidence_index.json: Pointers to sources
- summary.md: Human-readable summary

## Tips

- Always cite sources with artifact pointers
- Note confidence levels for uncertain findings
- Identify gaps in available information
`,
    ['research', 'analysis', 'data']
  );

  // File operations skill
  await registry.registerSkill(
    'file_ops',
    'file_operations',
    'Read, write, and manipulate files and directories',
    `## When to Use

Use this skill when you need to:
- Read file contents
- Write or update files
- Navigate directory structures
- Process file-based data

## Procedure

1. Identify the target files/directories
2. Use appropriate read/write operations
3. Store large outputs as artifacts
4. Reference by pointers, not inline content

## Tools Available

- read_file: Read file contents
- write_file: Write content to file
- list_directory: List directory contents
- search_files: Search by pattern

## Tips

- Never paste large file contents into prompts
- Use slicing for large files (head/tail/grep)
- Store outputs as artifacts with summaries
`,
    ['files', 'filesystem', 'io']
  );

  // Commit/Curation skill
  await registry.registerSkill(
    'curation',
    'curation',
    'Apply memory deltas and playbook diffs to finalize a run',
    `## When to Use

Use this skill in commit/curate nodes to:
- Merge staged memory updates
- Apply playbook improvements
- Finalize run outputs

## Procedure

1. Review all staged MemoryDelta artifacts
2. Validate evidence references
3. Apply deltas to MemoryStore
4. Review PlaybookDiff artifacts
5. Apply diffs to playbook files
6. Mark run as complete

## Rules

- Only commit nodes can apply memory updates
- All diffs must have evidence references
- Changes are auditable and reversible

## Tips

- Check confidence levels before applying
- Preserve failure context for learning
- Update pitfalls for mistakes encountered
`,
    ['curation', 'commit', 'memory']
  );
}
