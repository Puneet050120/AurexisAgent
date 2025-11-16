import { TaskResult } from '../types/agent';
import crypto from 'crypto';

interface CacheEntry {
  taskId: string;
  description: string;
  tool: string;
  parameters: Record<string, any>;
  result: any;
  timestamp: number;
}

class InMemoryCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly TTL = 24 * 60 * 60 * 1000; // 24 hours

  private generateHash(tool: string, params: Record<string, any>): string {
    const normalized = {
      tool,
      params: JSON.stringify(params, Object.keys(params).sort()),
    };
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [hash, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.TTL) {
        this.cache.delete(hash);
      }
    }
  }

  get(taskId: string, tool: string, params: Record<string, any>): TaskResult | null {
    this.cleanup();
    const hash = this.generateHash(tool, params);
    const entry = this.cache.get(hash);
    
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > this.TTL) {
      this.cache.delete(hash);
      return null;
    }

    return {
      taskId,
      status: 'completed',
      result: entry.result,
      startedAt: new Date(entry.timestamp),
      completedAt: new Date(entry.timestamp),
    };
  }

  set(taskId: string, description: string, tool: string, params: Record<string, any>, result: any): void {
    const hash = this.generateHash(tool, params);
    this.cache.set(hash, {
      taskId,
      description,
      tool,
      parameters: params,
      result,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    this.cleanup();
    return this.cache.size;
  }
}

export const taskCache = new InMemoryCache();
