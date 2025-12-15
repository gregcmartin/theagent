/**
 * AnthropicProvider - Default LLM provider using Anthropic Claude
 * 
 * Implements the LLM provider interface for all framework components.
 */

import Anthropic from '@anthropic-ai/sdk';
import { CompiledContext } from '../../core/types/index.js';

/**
 * Configuration for the Anthropic provider
 */
export interface AnthropicProviderConfig {
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  defaultMaxTokens?: number;
}

/**
 * Anthropic LLM Provider
 */
export class AnthropicProvider {
  private client: Anthropic;
  private model: string;
  private maxRetries: number;
  private defaultMaxTokens: number;

  constructor(config: AnthropicProviderConfig = {}) {
    // Use API key from config or environment
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable or pass apiKey in config.');
    }

    this.client = new Anthropic({ apiKey });
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.maxRetries = config.maxRetries || 3;
    this.defaultMaxTokens = config.defaultMaxTokens || 4096;
  }

  /**
   * Complete a prompt with the LLM
   */
  async complete(
    context: CompiledContext,
    opts: { maxTokens?: number } = {}
  ): Promise<string> {
    const maxTokens = opts.maxTokens || this.defaultMaxTokens;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: context.system,
      messages: context.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    });

    // Extract text from the response
    const textBlock = response.content.find(block => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Anthropic');
    }

    return textBlock.text;
  }

  /**
   * Complete with retry logic
   */
  async completeWithRetry(
    context: CompiledContext,
    opts: { maxTokens?: number } = {}
  ): Promise<string> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.complete(context, opts);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't retry on certain errors
        if (this.isNonRetryableError(error)) {
          throw lastError;
        }

        // Exponential backoff
        if (attempt < this.maxRetries - 1) {
          await this.sleep(Math.pow(2, attempt) * 1000);
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Stream a completion
   */
  async *stream(
    context: CompiledContext,
    opts: { maxTokens?: number } = {}
  ): AsyncGenerator<string, void, unknown> {
    const maxTokens = opts.maxTokens || this.defaultMaxTokens;

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      system: context.system,
      messages: context.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if ('text' in delta) {
          yield delta.text;
        }
      }
    }
  }

  /**
   * Get token count estimate for a context
   */
  estimateTokens(context: CompiledContext): number {
    // Rough estimate: ~4 characters per token
    const systemTokens = Math.ceil(context.system.length / 4);
    const messageTokens = context.messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0
    );
    return systemTokens + messageTokens;
  }

  /**
   * Check if an error should not be retried
   */
  private isNonRetryableError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      // Don't retry authentication or invalid request errors
      return error.status === 401 || error.status === 400;
    }
    return false;
  }

  /**
   * Sleep for a duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get the current model name
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Set the model to use
   */
  setModel(model: string): void {
    this.model = model;
  }
}

/**
 * Create a simple mock provider for testing
 */
export function createMockAnthropicProvider(
  handler: (context: CompiledContext) => Promise<string>
): AnthropicProvider {
  // Create a provider that doesn't require API key
  const provider = {
    complete: handler,
    completeWithRetry: handler,
    stream: async function* (context: CompiledContext) {
      yield await handler(context);
    },
    estimateTokens: (context: CompiledContext) => {
      const systemTokens = Math.ceil(context.system.length / 4);
      const messageTokens = context.messages.reduce(
        (sum, m) => sum + Math.ceil(m.content.length / 4),
        0
      );
      return systemTokens + messageTokens;
    },
    getModel: () => 'mock',
    setModel: () => {},
  } as unknown as AnthropicProvider;

  return provider;
}
