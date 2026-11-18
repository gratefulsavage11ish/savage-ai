// One in-flight chat request at a time, with an immutable provider snapshot.
//
// Providers are mutable objects in the UI (the model picker rewrites
// `provider.model`). A request must keep the provider identity it started with,
// so late tokens, a stale response or a provider switch can never relabel the
// result or attach telemetry to the wrong provider.
export class RequestLifecycle {
  #generation = 0;
  #active = null;

  begin(provider, { controller = null } = {}) {
    if (!provider || provider.id == null) throw new TypeError('A provider is required to start a request.');
    const id = ++this.#generation;
    const snapshot = Object.freeze({
      id: String(provider.id),
      name: String(provider.name ?? provider.id),
      adapter: String(provider.adapter ?? ''),
      model: String(provider.model ?? ''),
    });
    this.#active = Object.freeze({ id, provider: snapshot, controller });
    return this.#active;
  }

  /** True only while this exact request is the newest one and still active. */
  isCurrent(request) {
    return Boolean(request) && request.id === this.#generation && this.#active?.id === request.id;
  }

  isStale(request) { return !this.isCurrent(request); }

  finish(request) {
    if (request?.id === this.#active?.id) this.#active = null;
    return this.#active;
  }

  abort(request = this.#active) {
    try { request?.controller?.abort(); } catch { /* already aborted */ }
  }

  get active() { return this.#active; }
  get generation() { return this.#generation; }
}
