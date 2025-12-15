/**
 * SessionStore - Append-only event storage with compaction support
 * 
 * Events are immutable and include compaction events (summaries that replace/prune older spans).
 * Supports scoped visibility for node isolation.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  SessionEvent,
  SessionEventSchema,
  CompactionEvent,
  CompactionEventSchema,
} from '../types/index.js';

export interface SessionStoreConfig {
  basePath: string;
}

export interface EventQuery {
  runId: string;
  nodeId?: string;
  types?: string[];
  limit?: number;
  before?: string;
  after?: string;
}

export class SessionStore {
  private basePath: string;

  constructor(config: SessionStoreConfig) {
    this.basePath = config.basePath;
  }

  /**
   * Initialize the session store
   */
  async init(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }

  /**
   * Get the events file path for a run
   */
  private getEventsPath(runId: string): string {
    return path.join(this.basePath, runId, 'events.jsonl');
  }

  /**
   * Get the compactions file path for a run
   */
  private getCompactionsPath(runId: string): string {
    return path.join(this.basePath, runId, 'compactions.jsonl');
  }

  /**
   * Append an event to the session log
   */
  async appendEvent(event: Omit<SessionEvent, 'ts' | 'refs'> & { ts?: string; refs?: string[] }): Promise<SessionEvent> {
    const fullEvent: SessionEvent = SessionEventSchema.parse({
      ...event,
      ts: event.ts || new Date().toISOString(),
    });

    const eventsPath = this.getEventsPath(fullEvent.runId);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });

    // Append to JSONL file
    await fs.appendFile(
      eventsPath,
      JSON.stringify(fullEvent) + '\n',
      'utf-8'
    );

    return fullEvent;
  }

  /**
   * Store a compaction event (summaries older spans)
   */
  async appendCompactionEvent(event: CompactionEvent): Promise<CompactionEvent> {
    const validated = CompactionEventSchema.parse(event);
    const compactionsPath = this.getCompactionsPath(validated.runId);

    // Ensure directory exists
    await fs.mkdir(path.dirname(compactionsPath), { recursive: true });

    // Append to JSONL file
    await fs.appendFile(
      compactionsPath,
      JSON.stringify(validated) + '\n',
      'utf-8'
    );

    // Also append as a regular event for the timeline
    await this.appendEvent({
      runId: validated.runId,
      nodeId: validated.nodeId,
      type: 'compaction',
      refs: validated.artifactsIndex.map(a => a.handle),
      payload: { span: validated.span, summary: validated.summary },
    });

    return validated;
  }

  /**
   * Read all events for a run
   */
  async getEvents(query: EventQuery): Promise<SessionEvent[]> {
    const eventsPath = this.getEventsPath(query.runId);

    try {
      const content = await fs.readFile(eventsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      let events = lines.map(line => SessionEventSchema.parse(JSON.parse(line)));

      // Apply filters
      if (query.nodeId) {
        events = events.filter(e => e.nodeId === query.nodeId);
      }

      if (query.types && query.types.length > 0) {
        events = events.filter(e => query.types!.includes(e.type));
      }

      if (query.after) {
        events = events.filter(e => e.ts > query.after!);
      }

      if (query.before) {
        events = events.filter(e => e.ts < query.before!);
      }

      if (query.limit) {
        events = events.slice(-query.limit);
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * Get events for a node including its dependencies (scoped visibility)
   */
  async getEventsForNodeScope(
    runId: string,
    nodeId: string,
    depNodeIds: string[]
  ): Promise<SessionEvent[]> {
    const allNodeIds = [nodeId, ...depNodeIds];
    const allEvents = await this.getEvents({ runId });
    
    return allEvents.filter(e => 
      !e.nodeId || allNodeIds.includes(e.nodeId)
    );
  }

  /**
   * Get compaction events for a run
   */
  async getCompactionEvents(runId: string): Promise<CompactionEvent[]> {
    const compactionsPath = this.getCompactionsPath(runId);

    try {
      const content = await fs.readFile(compactionsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      return lines.map(line => CompactionEventSchema.parse(JSON.parse(line)));
    } catch {
      return [];
    }
  }

  /**
   * Get the latest compaction summary for a run/node
   */
  async getLatestCompaction(
    runId: string,
    nodeId?: string
  ): Promise<CompactionEvent | null> {
    const compactions = await this.getCompactionEvents(runId);
    
    const filtered = nodeId 
      ? compactions.filter(c => c.nodeId === nodeId)
      : compactions;

    return filtered.length > 0 ? filtered[filtered.length - 1] : null;
  }

  /**
   * Get events that have NOT been compacted
   */
  async getUncompactedEvents(runId: string): Promise<SessionEvent[]> {
    const events = await this.getEvents({ runId });
    const compactions = await this.getCompactionEvents(runId);

    if (compactions.length === 0) {
      return events;
    }

    // Find the latest compaction
    const latestCompaction = compactions[compactions.length - 1];
    const compactedToEventId = latestCompaction.span.toEventId;

    // Find the index of the last compacted event
    const compactedIndex = events.findIndex(e => 
      // Events are identified by runId + nodeId + stepId + type + ts
      `${e.runId}:${e.nodeId}:${e.stepId}:${e.type}:${e.ts}` === compactedToEventId
    );

    if (compactedIndex === -1) {
      return events;
    }

    return events.slice(compactedIndex + 1);
  }

  /**
   * Count events for a run (useful for maintenance triggers)
   */
  async countEvents(runId: string, nodeId?: string): Promise<number> {
    const events = await this.getEvents({ runId, nodeId });
    return events.length;
  }

  /**
   * Generate a unique event ID
   */
  generateEventId(event: SessionEvent): string {
    return `${event.runId}:${event.nodeId || ''}:${event.stepId || ''}:${event.type}:${event.ts}`;
  }

  /**
   * Delete all session data for a run
   */
  async deleteRun(runId: string): Promise<void> {
    const runPath = path.join(this.basePath, runId);
    await fs.rm(runPath, { recursive: true, force: true });
  }

  /**
   * List all run IDs
   */
  async listRuns(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.basePath, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Get run metadata (first and last event timestamps, event count)
   */
  async getRunMetadata(runId: string): Promise<{
    runId: string;
    firstEventTs: string | null;
    lastEventTs: string | null;
    eventCount: number;
    compactionCount: number;
  }> {
    const events = await this.getEvents({ runId });
    const compactions = await this.getCompactionEvents(runId);

    return {
      runId,
      firstEventTs: events.length > 0 ? events[0].ts : null,
      lastEventTs: events.length > 0 ? events[events.length - 1].ts : null,
      eventCount: events.length,
      compactionCount: compactions.length,
    };
  }
}
