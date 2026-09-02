/** Reads platform and module settings from the MDM service with a short cache; invalidated by mdm.settings.changed events. */
export class SettingsClient {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly mdmUrl: string, private readonly serviceToken: string, private readonly ttlMs = 30_000) {}
  invalidate(key?: string) { if (key) this.cache.delete(key); else this.cache.clear(); }
  async get<T = Record<string, unknown>>(key: string, fallback: T): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    try {
      const res = await fetch(`${this.mdmUrl}/internal/settings/${encodeURIComponent(key)}`, { headers: { 'x-service-token': this.serviceToken } });
      if (!res.ok) return fallback;
      const body = (await res.json()) as { success: boolean; data: T };
      const value = body.success && body.data != null ? { ...(fallback as object), ...(body.data as object) } as T : fallback;
      this.cache.set(key, { at: Date.now(), value });
      return value;
    } catch { return fallback; }
  }
  moduleGet<T = Record<string, unknown>>(moduleKey: string, fallback: T) { return this.get<T>(`module:${moduleKey}`, fallback); }
}
