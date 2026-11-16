// Secure-storage abstraction.
// Production: credentials live server-side, encrypted at rest (KMS envelope
// encryption + encrypted DB). The browser must never receive provider keys.
export class CredentialStore {
  async get() { throw new Error('Not implemented'); }
  async has() { throw new Error('Not implemented'); }
  async set() { throw new Error('Not implemented'); }
  async delete() { throw new Error('Not implemented'); }
}

// PROTOTYPE ONLY. Keys in localStorage are readable by any script on the origin.
export class LocalCredentialStore extends CredentialStore {
  constructor(storage = globalThis.localStorage) { super(); this.storage = storage; this.insecure = true; this.kind = 'local-dev'; }
  async get(id) { try { return this.storage?.getItem(`savage.key.${id}`) || ''; } catch { return ''; } }
  async has(id) { return Boolean(await this.get(id)); }
  async set(id, value) { this.storage?.setItem(`savage.key.${id}`, typeof value === 'string' ? value : value?.secret || ''); }
  async delete(id) { this.storage?.removeItem(`savage.key.${id}`); }
}

// Backend store: talks to the server vault. The API never returns secret material,
// so get() intentionally resolves to '' — `has()` is what the UI should use.
export class BackendCredentialStore extends CredentialStore {
  constructor(baseUrl = '/api/credentials', fetchImpl = globalThis.fetch) {
    super(); this.baseUrl = String(baseUrl).replace(/\/+$/, ''); this.fetchImpl = fetchImpl; this.insecure = false; this.kind = 'backend';
  }
  async #call(method, id, body) {
    const res = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const parsed = await res.json().catch(() => null); throw new Error(parsed?.error?.message || `Credential store returned HTTP ${res.status}`); }
    return res.json().catch(() => ({}));
  }
  async get() { return ''; } // secrets are never returned to the browser
  async has(id) { const r = await this.#call('GET', id); return Boolean(r.configured); }
  async set(id, value) {
    const payload = typeof value === 'string' ? { secret: value } : { secret: value?.secret ?? '', headers: value?.headers ?? undefined };
    await this.#call('PUT', id, payload);
  }
  async delete(id) { await this.#call('DELETE', id); }
}

export function createCredentialStore({ backendEndpoint } = {}) {
  return backendEndpoint ? new BackendCredentialStore(backendEndpoint) : new LocalCredentialStore();
}
