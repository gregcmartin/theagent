/**
 * ArtifactStore - Pointer-first blob/file storage
 * 
 * Large objects live outside prompts; we inject handles + summaries instead.
 * Everything is stored as ArtifactHandle with uri, contentHash, type, tags, shortSummary.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { ArtifactHandle, ArtifactHandleSchema } from '../types/index.js';

export interface ArtifactStoreConfig {
  basePath: string;
}

export class ArtifactStore {
  private basePath: string;

  constructor(config: ArtifactStoreConfig) {
    this.basePath = config.basePath;
  }

  /**
   * Initialize the artifact store (create directories if needed)
   */
  async init(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  /**
   * Compute content hash for deduplication
   */
  private computeHash(content: string | Buffer): string {
    const hash = crypto.createHash('sha256');
    hash.update(content);
    return hash.digest('hex').substring(0, 16);
  }

  /**
   * Build the full path for an artifact
   */
  private buildPath(namespace: string, name: string): string {
    return path.join(this.basePath, namespace, name);
  }

  /**
   * Store text content as an artifact
   */
  async putText(
    namespace: string,
    name: string,
    content: string,
    options: {
      tags?: string[];
      shortSummary?: string;
    } = {}
  ): Promise<ArtifactHandle> {
    const contentHash = this.computeHash(content);
    const artifactPath = this.buildPath(namespace, name);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    
    // Write content
    await fs.writeFile(artifactPath, content, 'utf-8');
    
    const handle: ArtifactHandle = {
      uri: artifactPath,
      contentHash,
      type: 'text',
      tags: options.tags || [],
      shortSummary: options.shortSummary || this.generateSummary(content),
    };

    // Also store metadata
    await fs.writeFile(
      `${artifactPath}.meta.json`,
      JSON.stringify(handle, null, 2),
      'utf-8'
    );

    return ArtifactHandleSchema.parse(handle);
  }

  /**
   * Store JSON content as an artifact
   */
  async putJson(
    namespace: string,
    name: string,
    obj: unknown,
    options: {
      tags?: string[];
      shortSummary?: string;
    } = {}
  ): Promise<ArtifactHandle> {
    const content = JSON.stringify(obj, null, 2);
    const contentHash = this.computeHash(content);
    const artifactPath = this.buildPath(namespace, name);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    
    // Write content
    await fs.writeFile(artifactPath, content, 'utf-8');
    
    const handle: ArtifactHandle = {
      uri: artifactPath,
      contentHash,
      type: 'json',
      tags: options.tags || [],
      shortSummary: options.shortSummary || this.generateJsonSummary(obj),
    };

    // Also store metadata
    await fs.writeFile(
      `${artifactPath}.meta.json`,
      JSON.stringify(handle, null, 2),
      'utf-8'
    );

    return ArtifactHandleSchema.parse(handle);
  }

  /**
   * Store markdown content as an artifact
   */
  async putMarkdown(
    namespace: string,
    name: string,
    content: string,
    options: {
      tags?: string[];
      shortSummary?: string;
    } = {}
  ): Promise<ArtifactHandle> {
    const contentHash = this.computeHash(content);
    const artifactPath = this.buildPath(namespace, name);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    
    // Write content
    await fs.writeFile(artifactPath, content, 'utf-8');
    
    const handle: ArtifactHandle = {
      uri: artifactPath,
      contentHash,
      type: 'markdown',
      tags: options.tags || [],
      shortSummary: options.shortSummary || this.generateSummary(content),
    };

    // Also store metadata
    await fs.writeFile(
      `${artifactPath}.meta.json`,
      JSON.stringify(handle, null, 2),
      'utf-8'
    );

    return ArtifactHandleSchema.parse(handle);
  }

  /**
   * Store binary content as an artifact
   */
  async putBinary(
    namespace: string,
    name: string,
    content: Buffer,
    options: {
      tags?: string[];
      shortSummary?: string;
    } = {}
  ): Promise<ArtifactHandle> {
    const contentHash = this.computeHash(content);
    const artifactPath = this.buildPath(namespace, name);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    
    // Write content
    await fs.writeFile(artifactPath, content);
    
    const handle: ArtifactHandle = {
      uri: artifactPath,
      contentHash,
      type: 'binary',
      tags: options.tags || [],
      shortSummary: options.shortSummary || `Binary file (${content.length} bytes)`,
    };

    // Also store metadata
    await fs.writeFile(
      `${artifactPath}.meta.json`,
      JSON.stringify(handle, null, 2),
      'utf-8'
    );

    return ArtifactHandleSchema.parse(handle);
  }

  /**
   * Get text content from an artifact handle
   */
  async getText(handle: ArtifactHandle | string): Promise<string> {
    const uri = typeof handle === 'string' ? handle : handle.uri;
    return fs.readFile(uri, 'utf-8');
  }

  /**
   * Get JSON content from an artifact handle
   */
  async getJson<T = unknown>(handle: ArtifactHandle | string): Promise<T> {
    const content = await this.getText(handle);
    return JSON.parse(content) as T;
  }

  /**
   * Get binary content from an artifact handle
   */
  async getBinary(handle: ArtifactHandle | string): Promise<Buffer> {
    const uri = typeof handle === 'string' ? handle : handle.uri;
    return fs.readFile(uri);
  }

  /**
   * Get artifact metadata
   */
  async getMetadata(uri: string): Promise<ArtifactHandle | null> {
    try {
      const metaPath = `${uri}.meta.json`;
      const content = await fs.readFile(metaPath, 'utf-8');
      return ArtifactHandleSchema.parse(JSON.parse(content));
    } catch {
      return null;
    }
  }

  /**
   * Check if an artifact exists
   */
  async exists(namespace: string, name: string): Promise<boolean> {
    try {
      const artifactPath = this.buildPath(namespace, name);
      await fs.access(artifactPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all artifacts in a namespace
   */
  async listNamespace(namespace: string): Promise<ArtifactHandle[]> {
    const namespacePath = path.join(this.basePath, namespace);
    
    try {
      const entries = await fs.readdir(namespacePath, { withFileTypes: true });
      const handles: ArtifactHandle[] = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.meta.json')) {
          const metaPath = path.join(namespacePath, entry.name);
          const content = await fs.readFile(metaPath, 'utf-8');
          handles.push(ArtifactHandleSchema.parse(JSON.parse(content)));
        }
      }

      return handles;
    } catch {
      return [];
    }
  }

  /**
   * Delete an artifact
   */
  async delete(namespace: string, name: string): Promise<void> {
    const artifactPath = this.buildPath(namespace, name);
    await fs.unlink(artifactPath).catch(() => {});
    await fs.unlink(`${artifactPath}.meta.json`).catch(() => {});
  }

  /**
   * Generate a short summary from text content
   */
  private generateSummary(content: string, maxLength: number = 100): string {
    const firstLine = content.split('\n')[0] || '';
    if (firstLine.length <= maxLength) {
      return firstLine;
    }
    return firstLine.substring(0, maxLength - 3) + '...';
  }

  /**
   * Generate a short summary from JSON content
   */
  private generateJsonSummary(obj: unknown): string {
    if (Array.isArray(obj)) {
      return `Array with ${obj.length} items`;
    }
    if (typeof obj === 'object' && obj !== null) {
      const keys = Object.keys(obj);
      return `Object with keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}`;
    }
    return String(obj).substring(0, 100);
  }

  /**
   * Create a slice/excerpt of a large artifact (for pointer-first approach)
   */
  async createSlice(
    handle: ArtifactHandle,
    options: {
      startLine?: number;
      endLine?: number;
      grep?: string;
      head?: number;
      tail?: number;
    }
  ): Promise<string> {
    const content = await this.getText(handle);
    const lines = content.split('\n');

    let result = lines;

    if (options.grep) {
      result = result.filter(line => line.includes(options.grep!));
    }

    if (options.startLine !== undefined && options.endLine !== undefined) {
      result = result.slice(options.startLine, options.endLine);
    }

    if (options.head !== undefined) {
      result = result.slice(0, options.head);
    }

    if (options.tail !== undefined) {
      result = result.slice(-options.tail);
    }

    return result.join('\n');
  }
}
