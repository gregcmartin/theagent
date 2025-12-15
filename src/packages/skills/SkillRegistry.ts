/**
 * SkillRegistry - Manages skill metadata and progressive loading
 * 
 * Skills are procedural knowledge stored as SKILL.md files with YAML frontmatter.
 * Metadata is preloaded at startup; full content is loaded on demand.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { SkillMeta, SkillMetaSchema } from '../core/types/index.js';

/**
 * Configuration for the skill registry
 */
export interface SkillRegistryConfig {
  skillsPath: string;
}

/**
 * Full skill content including the markdown body
 */
export interface Skill extends SkillMeta {
  content: string;
  path: string;
}

/**
 * Skill Registry for managing skills
 */
export class SkillRegistry {
  private skillsPath: string;
  private metadataCache: Map<string, SkillMeta> = new Map();
  private contentCache: Map<string, string> = new Map();

  constructor(config: SkillRegistryConfig) {
    this.skillsPath = config.skillsPath;
  }

  /**
   * Initialize the registry by scanning for skills
   */
  async init(): Promise<void> {
    await fs.mkdir(this.skillsPath, { recursive: true });
    await this.scanSkills();
  }

  /**
   * Scan the skills directory for SKILL.md files
   */
  private async scanSkills(): Promise<void> {
    try {
      const entries = await fs.readdir(this.skillsPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(this.skillsPath, entry.name, 'SKILL.md');
          try {
            const meta = await this.parseSkillMetadata(skillPath, entry.name);
            this.metadataCache.set(meta.id, meta);
          } catch {
            // Skip directories without valid SKILL.md
          }
        }
      }
    } catch {
      // Skills directory doesn't exist yet
    }
  }

  /**
   * Parse skill metadata from YAML frontmatter
   */
  private async parseSkillMetadata(skillPath: string, dirName: string): Promise<SkillMeta> {
    const content = await fs.readFile(skillPath, 'utf-8');
    
    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    
    if (!frontmatterMatch) {
      // No frontmatter, create minimal metadata
      return SkillMetaSchema.parse({
        id: dirName,
        name: dirName,
        description: `Skill: ${dirName}`,
        tags: [],
      });
    }

    const frontmatter = yaml.parse(frontmatterMatch[1]);
    
    return SkillMetaSchema.parse({
      id: dirName,
      name: frontmatter.name || dirName,
      description: frontmatter.description || `Skill: ${dirName}`,
      tags: frontmatter.tags || [],
    });
  }

  /**
   * List all skill metadata (cheap operation)
   */
  async listMetadata(): Promise<SkillMeta[]> {
    return Array.from(this.metadataCache.values());
  }

  /**
   * Get metadata for a specific skill
   */
  async getMetadata(skillId: string): Promise<SkillMeta | null> {
    return this.metadataCache.get(skillId) || null;
  }

  /**
   * Load full skill content (expensive operation - on demand only)
   */
  async loadSkillMarkdown(skillId: string): Promise<string> {
    // Check cache first
    const cached = this.contentCache.get(skillId);
    if (cached) {
      return cached;
    }

    const skillPath = path.join(this.skillsPath, skillId, 'SKILL.md');
    const content = await fs.readFile(skillPath, 'utf-8');
    
    // Remove frontmatter for the actual content
    const withoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
    
    // Cache the content
    this.contentCache.set(skillId, withoutFrontmatter);
    
    return withoutFrontmatter;
  }

  /**
   * Load a full skill with metadata and content
   */
  async loadSkill(skillId: string): Promise<Skill | null> {
    const meta = await this.getMetadata(skillId);
    if (!meta) {
      return null;
    }

    const content = await this.loadSkillMarkdown(skillId);
    
    return {
      ...meta,
      content,
      path: path.join(this.skillsPath, skillId, 'SKILL.md'),
    };
  }

  /**
   * Search skills by query (matches name, description, tags)
   */
  async search(query: string): Promise<SkillMeta[]> {
    const queryLower = query.toLowerCase();
    const results: SkillMeta[] = [];

    for (const meta of this.metadataCache.values()) {
      if (
        meta.name.toLowerCase().includes(queryLower) ||
        meta.description.toLowerCase().includes(queryLower) ||
        meta.tags.some((t: string) => t.toLowerCase().includes(queryLower))
      ) {
        results.push(meta);
      }
    }

    return results;
  }

  /**
   * Get skills by tags
   */
  async getByTags(tags: string[]): Promise<SkillMeta[]> {
    const tagSet = new Set(tags.map((t: string) => t.toLowerCase()));
    const results: SkillMeta[] = [];

    for (const meta of this.metadataCache.values()) {
      if (meta.tags.some((t: string) => tagSet.has(t.toLowerCase()))) {
        results.push(meta);
      }
    }

    return results;
  }

  /**
   * Register a new skill (creates the directory and SKILL.md)
   */
  async registerSkill(
    id: string,
    name: string,
    description: string,
    content: string,
    tags: string[] = []
  ): Promise<SkillMeta> {
    const skillDir = path.join(this.skillsPath, id);
    const skillPath = path.join(skillDir, 'SKILL.md');

    // Create directory
    await fs.mkdir(skillDir, { recursive: true });

    // Build the skill file
    const frontmatter = yaml.stringify({
      name,
      description,
      tags,
    });

    const fullContent = `---\n${frontmatter}---\n\n${content}`;

    // Write the file
    await fs.writeFile(skillPath, fullContent, 'utf-8');

    // Update cache
    const meta = SkillMetaSchema.parse({
      id,
      name,
      description,
      tags,
    });
    this.metadataCache.set(id, meta);
    this.contentCache.delete(id); // Clear content cache

    return meta;
  }

  /**
   * Update a skill
   */
  async updateSkill(
    id: string,
    updates: Partial<{ name: string; description: string; content: string; tags: string[] }>
  ): Promise<SkillMeta | null> {
    const existing = await this.loadSkill(id);
    if (!existing) {
      return null;
    }

    const newName = updates.name || existing.name;
    const newDescription = updates.description || existing.description;
    const newTags = updates.tags || existing.tags;
    const newContent = updates.content || existing.content;

    return this.registerSkill(id, newName, newDescription, newContent, newTags);
  }

  /**
   * Delete a skill
   */
  async deleteSkill(id: string): Promise<boolean> {
    const skillDir = path.join(this.skillsPath, id);

    try {
      await fs.rm(skillDir, { recursive: true });
      this.metadataCache.delete(id);
      this.contentCache.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a skill exists
   */
  async exists(skillId: string): Promise<boolean> {
    return this.metadataCache.has(skillId);
  }

  /**
   * Clear the content cache (to free memory)
   */
  clearContentCache(): void {
    this.contentCache.clear();
  }

  /**
   * Refresh the registry (rescan skills)
   */
  async refresh(): Promise<void> {
    this.metadataCache.clear();
    this.contentCache.clear();
    await this.scanSkills();
  }
}
