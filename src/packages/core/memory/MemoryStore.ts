/**
 * MemoryStore - Retrievable long-lived insights
 * 
 * Contains: constraints, facts, preferences, verified outcomes.
 * Supports vector/keyword/hybrid retrieval, but nothing is pinned by default.
 * Memory updates are staged via MemoryDelta and only applied by commit/curator.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  MemoryItem,
  MemoryItemSchema,
  MemoryDelta,
  MemoryDeltaSchema,
  MemoryAdds,
} from '../types/index.js';

export interface MemoryStoreConfig {
  basePath: string;
}

export type MemoryCategory = 'facts' | 'constraints' | 'preferences' | 'tactics' | 'pitfalls';

export interface MemoryQuery {
  query: string;
  categories?: MemoryCategory[];
  runId?: string;
  nodeId?: string;
  k?: number;
  minConfidence?: number;
}

export interface MemoryHit {
  item: MemoryItem;
  category: MemoryCategory;
  score: number;
}

export class MemoryStore {
  private basePath: string;
  private memory: Map<MemoryCategory, MemoryItem[]> = new Map();

  constructor(config: MemoryStoreConfig) {
    this.basePath = config.basePath;
  }

  /**
   * Initialize the memory store
   */
  async init(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    await this.load();
  }

  /**
   * Get path for a memory category file
   */
  private getCategoryPath(category: MemoryCategory): string {
    return path.join(this.basePath, `${category}.jsonl`);
  }

  /**
   * Load all memory from disk
   */
  async load(): Promise<void> {
    const categories: MemoryCategory[] = ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];

    for (const category of categories) {
      try {
        const content = await fs.readFile(this.getCategoryPath(category), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        const items = lines.map((line: string) => MemoryItemSchema.parse(JSON.parse(line)));
        this.memory.set(category, items);
      } catch {
        this.memory.set(category, []);
      }
    }
  }

  /**
   * Save a category to disk
   */
  private async saveCategory(category: MemoryCategory): Promise<void> {
    const items = this.memory.get(category) || [];
    const content = items.map((item: MemoryItem) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');
    await fs.writeFile(this.getCategoryPath(category), content, 'utf-8');
  }

  /**
   * Simple keyword-based retrieval (can be extended with embeddings)
   */
  async retrieve(query: MemoryQuery): Promise<MemoryHit[]> {
    const k = query.k || 10;
    const minConfidence = query.minConfidence || 0;
    const categories = query.categories || ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];
    const queryLower = query.query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    const hits: MemoryHit[] = [];

    for (const category of categories) {
      const items = this.memory.get(category) || [];

      for (const item of items) {
        if (item.confidence < minConfidence) continue;

        // Simple keyword matching score
        const textLower = item.text.toLowerCase();
        let matchCount = 0;
        for (const term of queryTerms) {
          if (textLower.includes(term)) {
            matchCount++;
          }
        }

        if (matchCount > 0) {
          const score = (matchCount / queryTerms.length) * item.confidence;
          hits.push({ item, category, score });
        }
      }
    }

    // Sort by score descending and take top k
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /**
   * Add a memory item directly (for internal use)
   */
  private async addItem(category: MemoryCategory, item: MemoryItem): Promise<void> {
    const items = this.memory.get(category) || [];
    
    // Check for duplicates by ID
    const existingIndex = items.findIndex((i: MemoryItem) => i.id === item.id);
    if (existingIndex >= 0) {
      items[existingIndex] = item;
    } else {
      items.push(item);
    }

    this.memory.set(category, items);
    await this.saveCategory(category);
  }

  /**
   * Apply a MemoryDelta (only called by commit/curator)
   */
  async applyMemoryDelta(delta: MemoryDelta): Promise<void> {
    const validated = MemoryDeltaSchema.parse(delta);

    const categories: MemoryCategory[] = ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];

    for (const category of categories) {
      const items = validated.adds[category] || [];
      for (const item of items) {
        await this.addItem(category, item);
      }
    }
  }

  /**
   * Apply a MemoryDelta from a JSON file handle
   */
  async applyMemoryDeltaFromFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const delta = MemoryDeltaSchema.parse(JSON.parse(content));
    await this.applyMemoryDelta(delta);
  }

  /**
   * Get all items in a category
   */
  async getCategory(category: MemoryCategory): Promise<MemoryItem[]> {
    return this.memory.get(category) || [];
  }

  /**
   * Get a specific item by ID
   */
  async getById(id: string): Promise<{ item: MemoryItem; category: MemoryCategory } | null> {
    const categories: MemoryCategory[] = ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];

    for (const category of categories) {
      const items = this.memory.get(category) || [];
      const item = items.find((i: MemoryItem) => i.id === id);
      if (item) {
        return { item, category };
      }
    }

    return null;
  }

  /**
   * Remove a memory item by ID
   */
  async removeById(id: string): Promise<boolean> {
    const categories: MemoryCategory[] = ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];

    for (const category of categories) {
      const items = this.memory.get(category) || [];
      const index = items.findIndex((i: MemoryItem) => i.id === id);
      if (index >= 0) {
        items.splice(index, 1);
        this.memory.set(category, items);
        await this.saveCategory(category);
        return true;
      }
    }

    return false;
  }

  /**
   * Count all memory items
   */
  async count(): Promise<Record<MemoryCategory, number>> {
    const categories: MemoryCategory[] = ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];
    const counts: Record<string, number> = {};

    for (const category of categories) {
      counts[category] = (this.memory.get(category) || []).length;
    }

    return counts as Record<MemoryCategory, number>;
  }

  /**
   * Export all memory as a JSON object
   */
  async exportAll(): Promise<Record<MemoryCategory, MemoryItem[]>> {
    const categories: MemoryCategory[] = ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];
    const result: Record<string, MemoryItem[]> = {};

    for (const category of categories) {
      result[category] = this.memory.get(category) || [];
    }

    return result as Record<MemoryCategory, MemoryItem[]>;
  }

  /**
   * Clear all memory
   */
  async clear(): Promise<void> {
    const categories: MemoryCategory[] = ['facts', 'constraints', 'preferences', 'tactics', 'pitfalls'];

    for (const category of categories) {
      this.memory.set(category, []);
      await this.saveCategory(category);
    }
  }

  /**
   * Create a staged MemoryDelta (for nodes to produce)
   */
  static createDelta(
    runId: string,
    nodeId: string,
    adds: Partial<MemoryAdds>
  ): MemoryDelta {
    return MemoryDeltaSchema.parse({
      runId,
      nodeId,
      adds: {
        facts: adds.facts || [],
        constraints: adds.constraints || [],
        preferences: adds.preferences || [],
        tactics: adds.tactics || [],
        pitfalls: adds.pitfalls || [],
      },
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Create a new memory item
   */
  static createItem(
    text: string,
    evidenceRefs: string[],
    confidence: number = 0.7
  ): MemoryItem {
    return MemoryItemSchema.parse({
      id: uuidv4(),
      text,
      evidenceRefs,
      confidence,
    });
  }
}
