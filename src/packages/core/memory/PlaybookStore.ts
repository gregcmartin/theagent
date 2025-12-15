/**
 * PlaybookStore - Self-improving strategy storage
 * 
 * Contains:
 * - playbook.md (tactics that worked)
 * - pitfalls.md (failure modes)
 * - policies.md (guardrails)
 * 
 * Updated only via typed diffs from Curator (ACE/Dynamic Cheatsheet style).
 * All changes are auditable and reversible.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  PlaybookDiff,
  PlaybookDiffSchema,
  PlaybookOp,
  PlaybookOpSchema,
} from '../types/index.js';

export interface PlaybookStoreConfig {
  basePath: string;
}

export type PlaybookFile = 'playbook.md' | 'pitfalls.md' | 'policies.md';

export interface PlaybookBullet {
  id: string;
  text: string;
  section?: string;
}

export class PlaybookStore {
  private basePath: string;
  private diffHistoryPath: string;

  constructor(config: PlaybookStoreConfig) {
    this.basePath = config.basePath;
    this.diffHistoryPath = path.join(config.basePath, 'diff_history.jsonl');
  }

  /**
   * Initialize the playbook store with default files
   */
  async init(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });

    // Create default playbook files if they don't exist
    const defaults: Record<PlaybookFile, string> = {
      'playbook.md': `# Playbook

## Tactics That Work

<!-- Bullets will be added here by the curator -->

`,
      'pitfalls.md': `# Pitfalls

## Known Failure Modes

<!-- Bullets will be added here by the curator -->

`,
      'policies.md': `# Policies

## Guardrails

- Always validate inputs before processing
- Never inject large outputs directly into prompts
- Stage all memory updates (never write directly)
- Keep artifact pointers, not raw content

`,
    };

    for (const [file, content] of Object.entries(defaults)) {
      const filePath = path.join(this.basePath, file);
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, content, 'utf-8');
      }
    }
  }

  /**
   * Get path for a playbook file
   */
  private getFilePath(file: PlaybookFile): string {
    return path.join(this.basePath, file);
  }

  /**
   * Read a playbook file
   */
  async read(file: PlaybookFile): Promise<string> {
    return fs.readFile(this.getFilePath(file), 'utf-8');
  }

  /**
   * Write a playbook file (internal use - prefer applyDiff)
   */
  private async write(file: PlaybookFile, content: string): Promise<void> {
    await fs.writeFile(this.getFilePath(file), content, 'utf-8');
  }

  /**
   * Parse bullets from markdown content
   */
  parseBullets(content: string): PlaybookBullet[] {
    const bullets: PlaybookBullet[] = [];
    const lines = content.split('\n');
    let currentSection = '';

    for (const line of lines) {
      if (line.startsWith('## ')) {
        currentSection = line.substring(3).trim();
      } else if (line.match(/^[-*]\s+/)) {
        // Extract bullet ID if present (format: - [id] text or just - text)
        const idMatch = line.match(/^[-*]\s+\[([^\]]+)\]\s*(.*)/);
        if (idMatch) {
          bullets.push({
            id: idMatch[1],
            text: idMatch[2],
            section: currentSection,
          });
        } else {
          const text = line.replace(/^[-*]\s+/, '');
          bullets.push({
            id: uuidv4().substring(0, 8),
            text,
            section: currentSection,
          });
        }
      }
    }

    return bullets;
  }

  /**
   * Format bullets back to markdown
   */
  formatBullets(bullets: PlaybookBullet[], originalContent: string): string {
    const lines = originalContent.split('\n');
    const result: string[] = [];
    let currentSection = '';
    let bulletIndex = 0;
    const bulletsBySection = new Map<string, PlaybookBullet[]>();

    // Group bullets by section
    for (const bullet of bullets) {
      const section = bullet.section || '';
      if (!bulletsBySection.has(section)) {
        bulletsBySection.set(section, []);
      }
      bulletsBySection.get(section)!.push(bullet);
    }

    // Reconstruct the file
    for (const line of lines) {
      if (line.startsWith('## ')) {
        currentSection = line.substring(3).trim();
        result.push(line);
        
        // Add bullets for this section
        const sectionBullets = bulletsBySection.get(currentSection) || [];
        for (const bullet of sectionBullets) {
          result.push(`- [${bullet.id}] ${bullet.text}`);
        }
      } else if (!line.match(/^[-*]\s+/)) {
        // Keep non-bullet lines
        result.push(line);
      }
    }

    return result.join('\n');
  }

  /**
   * Apply a single operation to a playbook file
   */
  private async applyOp(op: PlaybookOp): Promise<void> {
    const content = await this.read(op.targetFile);
    const bullets = this.parseBullets(content);

    switch (op.op) {
      case 'ADD_BULLET': {
        const newBullet: PlaybookBullet = {
          id: op.bulletId || uuidv4().substring(0, 8),
          text: op.after || '',
          section: this.inferSection(op.targetFile),
        };
        bullets.push(newBullet);
        break;
      }
      case 'REMOVE_BULLET': {
        const index = bullets.findIndex((b: PlaybookBullet) => b.id === op.bulletId || b.text === op.before);
        if (index >= 0) {
          bullets.splice(index, 1);
        }
        break;
      }
      case 'EDIT_BULLET': {
        const bullet = bullets.find((b: PlaybookBullet) => b.id === op.bulletId || b.text === op.before);
        if (bullet && op.after) {
          bullet.text = op.after;
        }
        break;
      }
    }

    const newContent = this.formatBullets(bullets, content);
    await this.write(op.targetFile, newContent);
  }

  /**
   * Infer the default section for a file
   */
  private inferSection(file: PlaybookFile): string {
    switch (file) {
      case 'playbook.md':
        return 'Tactics That Work';
      case 'pitfalls.md':
        return 'Known Failure Modes';
      case 'policies.md':
        return 'Guardrails';
      default:
        return '';
    }
  }

  /**
   * Apply a PlaybookDiff (only called by commit/curator)
   */
  async applyDiff(diff: PlaybookDiff): Promise<void> {
    const validated = PlaybookDiffSchema.parse(diff);

    // Apply each operation
    for (const op of validated.ops) {
      await this.applyOp(op);
    }

    // Store in diff history for auditability
    await fs.appendFile(
      this.diffHistoryPath,
      JSON.stringify(validated) + '\n',
      'utf-8'
    );
  }

  /**
   * Apply a PlaybookDiff from a JSON file handle
   */
  async applyDiffFromFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const diff = PlaybookDiffSchema.parse(JSON.parse(content));
    await this.applyDiff(diff);
  }

  /**
   * Get diff history
   */
  async getDiffHistory(): Promise<PlaybookDiff[]> {
    try {
      const content = await fs.readFile(this.diffHistoryPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.map((line: string) => PlaybookDiffSchema.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }

  /**
   * Rollback a specific diff by ID/timestamp
   */
  async rollback(createdAt: string): Promise<void> {
    const history = await this.getDiffHistory();
    const diffToRollback = history.find((d: PlaybookDiff) => d.createdAt === createdAt);

    if (!diffToRollback) {
      throw new Error(`Diff not found: ${createdAt}`);
    }

    // Create inverse operations
    const inverseOps: PlaybookOp[] = diffToRollback.ops.map((op: PlaybookOp) => {
      switch (op.op) {
        case 'ADD_BULLET':
          return { ...op, op: 'REMOVE_BULLET' as const, before: op.after };
        case 'REMOVE_BULLET':
          return { ...op, op: 'ADD_BULLET' as const, after: op.before };
        case 'EDIT_BULLET':
          return { ...op, before: op.after, after: op.before };
        default:
          return op;
      }
    });

    // Apply inverse diff
    const inverseDiff: PlaybookDiff = {
      runId: diffToRollback.runId + '_rollback',
      nodeId: 'rollback',
      ops: inverseOps,
      createdAt: new Date().toISOString(),
    };

    await this.applyDiff(inverseDiff);
  }

  /**
   * Get an excerpt of pitfalls for recitation
   */
  async getPitfallsExcerpt(maxItems: number = 5): Promise<string[]> {
    const content = await this.read('pitfalls.md');
    const bullets = this.parseBullets(content);
    return bullets.slice(0, maxItems).map((b: PlaybookBullet) => b.text);
  }

  /**
   * Get an excerpt of playbook tactics for context
   */
  async getPlaybookExcerpt(maxItems: number = 5): Promise<string[]> {
    const content = await this.read('playbook.md');
    const bullets = this.parseBullets(content);
    return bullets.slice(0, maxItems).map((b: PlaybookBullet) => b.text);
  }

  /**
   * Get policies for guardrails
   */
  async getPolicies(): Promise<string[]> {
    const content = await this.read('policies.md');
    const bullets = this.parseBullets(content);
    return bullets.map((b: PlaybookBullet) => b.text);
  }

  /**
   * Create a PlaybookDiff (for nodes to produce)
   */
  static createDiff(
    runId: string,
    nodeId: string,
    ops: PlaybookOp[]
  ): PlaybookDiff {
    return PlaybookDiffSchema.parse({
      runId,
      nodeId,
      ops,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Create an ADD_BULLET operation
   */
  static addBullet(
    targetFile: PlaybookFile,
    text: string,
    reason: string,
    evidenceRefs: string[],
    confidence: number = 0.7
  ): PlaybookOp {
    return PlaybookOpSchema.parse({
      op: 'ADD_BULLET',
      targetFile,
      bulletId: uuidv4().substring(0, 8),
      after: text,
      reason,
      evidenceRefs,
      confidence,
    });
  }

  /**
   * Create a REMOVE_BULLET operation
   */
  static removeBullet(
    targetFile: PlaybookFile,
    bulletId: string,
    reason: string,
    evidenceRefs: string[]
  ): PlaybookOp {
    return PlaybookOpSchema.parse({
      op: 'REMOVE_BULLET',
      targetFile,
      bulletId,
      reason,
      evidenceRefs,
    });
  }

  /**
   * Create an EDIT_BULLET operation
   */
  static editBullet(
    targetFile: PlaybookFile,
    bulletId: string,
    before: string,
    after: string,
    reason: string,
    evidenceRefs: string[],
    confidence: number = 0.7
  ): PlaybookOp {
    return PlaybookOpSchema.parse({
      op: 'EDIT_BULLET',
      targetFile,
      bulletId,
      before,
      after,
      reason,
      evidenceRefs,
      confidence,
    });
  }
}
