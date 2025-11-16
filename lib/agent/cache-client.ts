import { type TaskResult } from '../types/agent';

type CacheValue = {
	result: any;
	timestamp: number;
};

export interface AgentCache {
	get(key: string): Promise<TaskResult | null>;
	set(key: string, result: any, ttlMs?: number): Promise<void>;
	generateKey(parts: Record<string, any>): string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function fnv1aHash(input: string): string {
	let hash = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// 32-bit FNV prime multiplication
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	// Convert to unsigned 32-bit and hex
	return (hash >>> 0).toString(16).padStart(8, '0');
}

class InMemoryAgentCache implements AgentCache {
	private store = new Map<string, CacheValue>();

	async get(key: string): Promise<TaskResult | null> {
		const entry = this.store.get(key);
		if (!entry) return null;
		if (Date.now() - entry.timestamp > DEFAULT_TTL_MS) {
			this.store.delete(key);
			return null;
		}
		return {
			taskId: key,
			status: 'completed',
			result: entry.result,
			startedAt: new Date(entry.timestamp),
			completedAt: new Date(entry.timestamp),
		};
	}

	async set(key: string, result: any, ttlMs = DEFAULT_TTL_MS): Promise<void> {
		this.store.set(key, { result, timestamp: Date.now() });
		// TTL cleanup (best-effort)
		setTimeout(() => {
			const v = this.store.get(key);
			if (v && Date.now() - v.timestamp > ttlMs) {
				this.store.delete(key);
			}
		}, ttlMs + 1000).unref?.();
	}

	generateKey(parts: Record<string, any>): string {
		const normalized = JSON.stringify(parts, Object.keys(parts).sort());
		return fnv1aHash(normalized);
	}
}

class UpstashRedisAgentCache implements AgentCache {
	private client: any;

	constructor(client: any) {
		this.client = client;
	}

	async get(key: string): Promise<TaskResult | null> {
		try {
			const data = (await this.client.get(key)) as CacheValue | null;
			if (!data) return null;
			return {
				taskId: key,
				status: 'completed',
				result: data.result,
				startedAt: new Date(data.timestamp),
				completedAt: new Date(data.timestamp),
			};
		} catch {
			return null;
		}
	}

	async set(key: string, result: any, ttlMs = DEFAULT_TTL_MS): Promise<void> {
		try {
			const value: CacheValue = { result, timestamp: Date.now() };
			const ttlSec = Math.floor(ttlMs / 1000);
			await this.client.set(key, value, { ex: ttlSec });
		} catch {
			// best-effort; ignore
		}
	}

	generateKey(parts: Record<string, any>): string {
		const normalized = JSON.stringify(parts, Object.keys(parts).sort());
		return fnv1aHash(normalized);
	}
}

let cacheInstance: AgentCache | null = null;

export function getAgentCache(): AgentCache {
	if (cacheInstance) return cacheInstance;
	const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
	const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
	if (upstashUrl && upstashToken) {
		// Lazy dynamic import guarded by env presence; tolerate missing dependency locally
		let client: any = null;
		const ensure = async (): Promise<any | null> => {
			if (client) return client;
			try {
				const mod = await import('@upstash/redis');
				client = new mod.Redis({ url: upstashUrl, token: upstashToken });
				return client;
			} catch {
				cacheInstance = new InMemoryAgentCache();
				return null;
			}
		};
		return (cacheInstance = {
			async get(key: string): Promise<TaskResult | null> {
				const c = await ensure();
				if (!c) return (cacheInstance as AgentCache).get(key);
				try {
					const data = (await c.get(key)) as CacheValue | null;
					if (!data) return null;
					return {
						taskId: key,
						status: 'completed',
						result: data.result,
						startedAt: new Date(data.timestamp),
						completedAt: new Date(data.timestamp),
					};
				} catch {
					return null;
				}
			},
			async set(key: string, result: any, ttlMs = DEFAULT_TTL_MS): Promise<void> {
				const c = await ensure();
				if (!c) return (cacheInstance as AgentCache).set(key, result, ttlMs);
				try {
					const value: CacheValue = { result, timestamp: Date.now() };
					const ttlSec = Math.floor(ttlMs / 1000);
					await c.set(key, value, { ex: ttlSec });
				} catch {
					// no-op
				}
			},
			generateKey(parts: Record<string, any>): string {
				const normalized = JSON.stringify(parts, Object.keys(parts).sort());
				return fnv1aHash(normalized);
			},
		});
	}
	cacheInstance = new InMemoryAgentCache();
	return cacheInstance;
}

export const TASK_TTL_MS = DEFAULT_TTL_MS;


