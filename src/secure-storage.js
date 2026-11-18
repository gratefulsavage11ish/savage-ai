// Credential storage abstraction.
//
// There is deliberately no browser-side store any more. Provider keys and
// custom auth headers live in the server vault; the browser only ever learns
// `{ configured: boolean }`. If the backend is unavailable the UI fails closed
// and asks for the server instead of falling back to localStorage.
export class CredentialStore {
  async get() { throw new Error('Not implemented'); }
  async has() { throw new Error('Not implemented'); }
  async set() { throw new Error('Not implemented'); }
  async delete() { throw new Error('Not implemented'); }
}

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
