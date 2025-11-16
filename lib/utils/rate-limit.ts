interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

export function rateLimit(identifier: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);
  
  if (!entry || now > entry.resetAt) {
    const newEntry: RateLimitEntry = {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW,
    };
    rateLimitStore.set(identifier, newEntry);
    
    const expired = Array.from(rateLimitStore.entries())
      .filter(([_, e]) => now > e.resetAt);
    expired.forEach(([key]) => rateLimitStore.delete(key));
    
    return {
      allowed: true,
      remaining: RATE_LIMIT_MAX_REQUESTS - 1,
      resetAt: newEntry.resetAt,
    };
  }
  
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }
  
  entry.count++;
  rateLimitStore.set(identifier, entry);
  
  return {
    allowed: true,
    remaining: RATE_LIMIT_MAX_REQUESTS - entry.count,
    resetAt: entry.resetAt,
  };
}

export function getClientIdentifier(req: any): string {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0] : req.headers.get('x-real-ip') || 'unknown';
  return ip;
}
