import { redactValue } from './redaction.js';

interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export interface CacheHit<T> {
  value: T;
  ageMs: number;
  stale: boolean;
}

/**
 * Small in-process TTL cache for provider responses (spec section 37).
 *
 * Deliberately not backed by Redis: entries hold mapped infrastructure state
 * that is cheap to refetch, and keeping it in-process avoids putting inventory
 * data in a second system. Credentials are never cached — `set` rejects values
 * whose redacted form differs from the original, which catches accidental
 * caching of a secret-bearing object.
 */
export class TtlCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  /** Last successfully cached value per key, kept for outage fallbacks. */
  private readonly lastKnownGood = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly maxEntries = 2000) {}

  get<T>(key: string): CacheHit<T> | null {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return null;
    }
    return { value: entry.value, ageMs: now - entry.storedAt, stale: false };
  }

  /**
   * Returns the most recent value for a key even if its TTL has passed. Used to
   * render "last successful sync" when a provider is down (spec section 36).
   */
  getStale<T>(key: string): CacheHit<T> | null {
    const entry = (this.store.get(key) ?? this.lastKnownGood.get(key)) as
      | CacheEntry<T>
      | undefined;
    if (!entry) return null;
    const now = Date.now();
    return { value: entry.value, ageMs: now - entry.storedAt, stale: entry.expiresAt <= now };
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (containsSecret(value)) {
      throw new Error(`Refusing to cache key "${key}": value contains secret-shaped fields`);
    }
    if (this.store.size >= this.maxEntries) {
      // Cheap eviction: drop the oldest insertion.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    const entry: CacheEntry<T> = {
      value,
      storedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.store.set(key, entry);
    this.lastKnownGood.set(key, entry);
  }

  /**
   * Cache-aside helper. On loader failure, falls back to the stale entry when
   * `fallbackToStale` is set, so the UI can keep showing last-known-good data.
   */
  async wrap<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: { fallbackToStale?: boolean } = {},
  ): Promise<{ value: T; cachedAgeMs?: number; stale: boolean }> {
    const hit = this.get<T>(key);
    if (hit) {
      return { value: hit.value, cachedAgeMs: hit.ageMs, stale: false };
    }
    try {
      const value = await loader();
      this.set(key, value, ttlMs);
      return { value, stale: false };
    } catch (error) {
      if (options.fallbackToStale) {
        const stale = this.getStale<T>(key);
        if (stale) {
          return { value: stale.value, cachedAgeMs: stale.ageMs, stale: true };
        }
      }
      throw error;
    }
  }

  invalidate(keyOrPrefix: string, prefix = false): void {
    if (!prefix) {
      this.store.delete(keyOrPrefix);
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(keyOrPrefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
    this.lastKnownGood.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

function containsSecret(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  try {
    return JSON.stringify(redactValue(value)) !== JSON.stringify(value);
  } catch {
    // Unserialisable values (circular, class instances) are not cacheable anyway.
    return false;
  }
}

/** Shared cache instance used by the provider services. */
export const providerCache = new TtlCache();
