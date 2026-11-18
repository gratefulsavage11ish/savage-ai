import { createDefaultRegistry, BUILTIN_PROVIDERS } from './src/provider-registry.js';
import { ChatService } from './src/chat-service.js';
import { Telemetry } from './src/telemetry.js';
import { BackendCredentialStore } from './src/secure-storage.js';
import { SseParser } from './src/sse.js';
import { RequestLifecycle } from './src/request-lifecycle.js';
import { NormalizedError, CATEGORY_LABELS } from './src/errors.js';

const $ = (s) => document.querySelector(s);
const registry = createDefaultRegistry();
const telemetry = new Telemetry();
const service = new ChatService(registry, telemetry);
const LS_P = 'savage.providers', LS_A = 'savage.active';

let providers = load();
let activeId = localStorage.getItem(LS_A) || providers.find(p => p.enabled)?.id || null;
let history = [], streaming = false, editingId = null, proxyMode = false, store = null, modalOpener = null;
const lifecycle = new RequestLifecycle();
const metrics = {};

async function detectBackend() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === 'savage-ai' ? body : null;
  } catch { return null; }
}
const health = await detectBackend();
proxyMode = Boolean(health);
// Fail closed: without the backend there is no credential store at all.
// Provider keys are never written to this browser or localStorage.
store = proxyMode ? new BackendCredentialStore() : null;

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_P) || 'null');
    if (Array.isArray(parsed) && parsed.length) {
      // Older builds could have persisted keys/headers. Scrub them on load.
      return parsed.map(({ apiKey, customHeaders, hasCredential, ...rest }) => ({ ...rest, hasCredential: false }));
    }
  } catch { /* ignore corrupt storage */ }
  return structuredClone(BUILTIN_PROVIDERS);
}
function save() {
  // Secrets and custom headers never go to localStorage.
  const safe = providers.map(({ apiKey, customHeaders, hasCredential, ...rest }) => rest);
  try { localStorage.setItem(LS_P, JSON.stringify(safe)); localStorage.setItem(LS_A, activeId || ''); } catch { /* private mode */ }
}
const activeProvider = () => providers.find(p => p.id === activeId) || null;
const authLabel = (p) => (p.hasCredential ? 'key stored' : proxyMode ? 'no key stored' : 'server required for keys');

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}
function normalizedFrom(error, fallbackStatus) {
  const category = error?.category && CATEGORY_LABELS[error.category] ? error.category : 'unknown_error';
  return new NormalizedError({ category, message: error?.message || `Proxy error (HTTP ${fallbackStatus ?? '?'})`, status: error?.status ?? fallbackStatus ?? null, retryable: Boolean(error?.retryable), providerId: error?.providerId, model: error?.model, code: error?.code });
}
async function proxyError(res) {
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return normalizedFrom(body?.error, res.status);
}
function publicProvider(p) {
  return { id: p.id, name: p.name, adapter: p.adapter, endpoint: p.endpoint, model: p.model, pricing: p.pricing || null, timeoutMs: p.timeoutMs || 60000 };
}
async function proxyCall(provider, action, body = {}) {
  const res = await fetch(`/api/proxy/${encodeURIComponent(provider.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: publicProvider(provider), ...body }) });
  if (!res.ok) throw await proxyError(res);
  const payload = await res.json();
  if (!payload.ok) throw normalizedFrom(payload.error, res.status);
  return payload.result;
}
async function proxyChat(provider, messages, options = {}) {
  const res = await fetch(`/api/proxy/${encodeURIComponent(provider.id)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: options.signal, body: JSON.stringify({ provider: publicProvider(provider), messages, options: { stream: Boolean(options.stream), temperature: options.temperature, maxTokens: options.maxTokens } }) });
  if (!res.ok) throw await proxyError(res);
  if (!String(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const payload = await res.json();
    if (!payload.ok) throw normalizedFrom(payload.error, res.status);
    return payload.result;
  }
  if (!res.body) throw new NormalizedError({ category: 'connection_error', code: 'stream_unavailable', message: 'Streaming is not available in this browser.' });
  const reader = res.body.getReader();
  const parser = new SseParser();
  let result = null, failure = null, released = false;
  // A Stop (or a provider switch) must cancel the body read, not just the fetch.
  const release = async () => { if (released) return; released = true; try { await reader.cancel(); } catch { /* already closed */ } };
  const onAbort = () => { void release(); };
  options.signal?.addEventListener?.('abort', onAbort, { once: true });
  const handle = (event) => {
    if (event.type === 'done') return;
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; } // keep-alive / partial frame
    if (payload.type === 'token') options.onToken?.(payload.text, payload.full);
    else if (payload.type === 'done') result = payload.result;
    else if (payload.type === 'error') failure = payload.error;
  };
  try {
    if (options.signal?.aborted) throw new NormalizedError({ category: 'timeout', code: 'user_cancelled', cancelled: true, message: 'Cancelled by you. Provider and model were kept as selected.' });
    while (!parser.done) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.feed(value)) handle(event);
    }
    for (const event of parser.flush()) handle(event);
  } catch (error) {
    if (options.signal?.aborted) throw new NormalizedError({ category: 'timeout', code: 'user_cancelled', cancelled: true, message: 'Cancelled by you. Provider and model were kept as selected.' });
    throw error instanceof NormalizedError ? error : normalizedFrom(error);
  } finally {
    options.signal?.removeEventListener?.('abort', onAbort);
    await release();
  }
  if (failure) throw normalizedFrom(failure);
  if (!result) throw new NormalizedError({ category: 'connection_error', code: 'stream_incomplete', message: 'The stream ended before the server sent a result. Nothing was switched.' });
  return result;
}
async function runTest(provider) { return proxyMode ? proxyCall(provider, 'test') : service.test(provider); }
async function runModels(provider) { return proxyMode ? proxyCall(provider, 'models') : service.listModels(provider); }
async function runChat(provider, messages, options) { return proxyMode ? proxyChat(provider, messages, options) : service.send(provider, messages, options); }
function recordClientTelemetry(result, provider, failed = null) {
  if (!proxyMode) return; // local mode records inside ChatService
  telemetry.record(failed
    ? { ok: false, providerId: provider.id, model: provider.model, latencyMs: failed.latencyMs ?? 0, category: failed.category, kind: 'chat' }
    : { ok: true, providerId: provider.id, model: result.model, latencyMs: result.latencyMs, cost: result.cost, usage: result.usage, requestId: result.requestId, kind: 'chat' });
}

async function hydrateCredentials() {
  if (!proxyMode || !store) { providers.forEach(p => { delete p.apiKey; p.hasCredential = false; }); return; }
  for (const p of providers) p.hasCredential = await store.has(p.id).catch(() => false);
}

function render() {
  const a = activeProvider();
  $('#adapterList').textContent = registry.list().map(x => `${x.label}${x.supportsStreaming ? ' (stream)' : ''}`).join(', ');
  const select = $('#providerSelect');
  const enabled = providers.filter(p => p.enabled);
  select.innerHTML = enabled.length ? enabled.map(p => `<option value="${p.id}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)} — ${escapeHtml(p.model || 'no model')}</option>`).join('') : '<option value="">No enabled provider</option>';
  $('#modelInput').value = a?.model || '';
  $('#activePill').textContent = a ? `● ${a.name} · ${a.model || 'no model'}` : 'No provider active';
  $('#chatSub').textContent = a
    ? `Active: ${a.name} · ${a.model || '—'}. SAVAGE never switches providers or models automatically.`
    : 'No provider selected. Add or enable one — SAVAGE will not pick one for you.';
  $('#storageWarn').textContent = proxyMode
    ? '🔒 Credentials are held by the server vault and never sent to the browser. Development vault — add auth + KMS before production.'
    : '⚠ Server backend not detected. API keys are never stored in this browser — run `node server.mjs` to configure providers securely.';
  $('#streamToggle').hidden = !(a && registry.get(a.adapter)?.supportsStreaming);
  renderProviders();
  renderEvaluation();
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function providerCard(p) {
  const m = metrics[p.id] || {};
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h3><span class="dot ${p.enabled ? 'on' : 'off'}" aria-hidden="true"></span>${escapeHtml(p.name)}</h3>
    <div class="muted">${escapeHtml(p.adapter)} · ${escapeHtml(p.endpoint || 'no endpoint')}<br>
      Model: <b>${escapeHtml(p.model || '—')}</b><br>
      ${escapeHtml(authLabel(p))}${p.builtin ? ' · built-in' : ''}<br>
      ${m.latency != null ? `Latency ${m.latency}ms · ${m.count || 0} requests` : 'No requests yet'}
    </div>
    <div class="row">
      <button class="btn" data-act="activate" ${p.id === activeId ? 'disabled' : ''}>${p.id === activeId ? 'Active' : 'Select'}</button>
      <button class="btn ghost" data-act="test">Test connection</button>
      <button class="btn ghost" data-act="models">Models</button>
      <button class="btn ghost menu-trigger" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${escapeHtml(p.name)}">⋯</button>
    </div>
    <ul class="models muted" aria-live="polite"></ul>`;
  card.querySelectorAll('button[data-act]').forEach(button => { button.addEventListener('click', event => handleProviderAction(p, button.dataset.act, event, card)); });
  return card;
}
function renderProviders() {
  const grid = $('#providerGrid');
  grid.innerHTML = '';
  const ordered = [...providers].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  ordered.forEach(p => grid.append(providerCard(p)));
}
async function handleProviderAction(p, action, event, card) {
  const button = event.currentTarget;
  if (action === 'activate') {
    activeId = p.id; save(); render(); toast(`Active provider: ${p.name} (unchanged until you pick another)`);
    return;
  }
  if (action === 'test') {
    button.disabled = true; const original = button.textContent; button.textContent = 'Testing…';
    try {
      const result = await runTest(p);
      metrics[p.id] = { latency: result.latencyMs, count: (metrics[p.id]?.count || 0) + 1 };
      p.hasCredential = proxyMode ? p.hasCredential : Boolean(p.apiKey);
      toast(`✓ ${result.message || `Connected in ${result.latencyMs}ms`}`);
    } catch (err) { toast(`✗ ${CATEGORY_LABELS[err.category] || err.category}: ${err.message}`, true); }
    finally { button.disabled = false; button.textContent = original; renderProviders(); }
    return;
  }
  if (action === 'models') {
    button.disabled = true; const original = button.textContent; button.textContent = 'Loading…';
    try {
      const result = await runModels(p);
      const list = card.querySelector('.models');
      list.innerHTML = '';
      if (!result.models?.length) list.innerHTML = '<li>No models returned</li>';
      else result.models.slice(0, 50).forEach(model => {
        const li = document.createElement('li');
        const pick = document.createElement('button');
        pick.className = 'linklike'; pick.type = 'button'; pick.textContent = model.id;
        pick.title = 'Use this model for this provider';
        pick.addEventListener('click', () => { p.model = model.id; save(); render(); toast(`Model set to ${model.id}`); });
        li.append(pick); list.append(li);
      });
    } catch (err) { toast(`✗ ${CATEGORY_LABELS[err.category] || err.category}: ${err.message}`, true); }
    finally { button.disabled = false; button.textContent = original; }
    return;
  }
  if (action === 'menu') openProviderMenu(p, button);
}

// ---------- Accessible provider menu (no prompt/confirm dialogs) ----------
function closeProviderMenu(restoreFocus = false) {
  const menu = document.querySelector('.menu-pop');
  if (!menu) return;
  const trigger = menu.__trigger;
  menu.remove();
  if (trigger) { trigger.setAttribute('aria-expanded', 'false'); if (restoreFocus) trigger.focus(); }
}
function menuItem(label, onSelect, { danger = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1; button.textContent = label;
  if (danger) button.classList.add('danger');
  button.addEventListener('click', async (event) => { event.stopPropagation(); closeProviderMenu(true); await onSelect(); });
  return button;
}
function openProviderMenu(p, trigger) {
  closeProviderMenu();
  const menu = document.createElement('div');
  menu.className = 'menu-pop'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `Actions for ${p.name}`); menu.tabIndex = -1;
  menu.__trigger = trigger;
  menu.append(
    menuItem('Edit provider', () => openModal(p)),
    menuItem(p.enabled ? 'Disable provider' : 'Enable provider', () => { p.enabled = !p.enabled; save(); render(); toast(`${p.name} ${p.enabled ? 'enabled' : 'disabled'}`); }),
    menuItem('Remove provider…', () => showRemoveConfirm(p, menu), { danger: true }),
  );
  document.body.append(menu);
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 232))}px`;
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 160)}px`;
  trigger.setAttribute('aria-expanded', 'true');
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeProviderMenu(true); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus(); }
    else if (event.key === 'Tab') { closeProviderMenu(); }
  });
  menu.querySelector('[role="menuitem"]')?.focus();
}
function showRemoveConfirm(p, menu) {
  menu.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'menu-label'; label.textContent = `Remove ${p.name}?`;
  const remove = document.createElement('button');
  remove.type = 'button'; remove.setAttribute('role', 'menuitem'); remove.className = 'danger'; remove.textContent = 'Remove provider';
  remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    closeProviderMenu(true);
    providers = providers.filter(x => x.id !== p.id);
    await store?.delete(p.id).catch(() => {});
    if (activeId === p.id) activeId = providers.find(x => x.enabled)?.id || providers[0]?.id || null;
    save(); render(); toast(`${p.name} removed`);
  });
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.setAttribute('role', 'menuitem'); cancel.textContent = 'Cancel';
  cancel.addEventListener('click', (event) => { event.stopPropagation(); closeProviderMenu(true); });
  menu.append(label, remove, cancel);
  remove.focus();
}
document.addEventListener('click', (event) => {
  const menu = document.querySelector('.menu-pop');
  if (menu && !menu.contains(event.target) && !menu.__trigger.contains(event.target)) closeProviderMenu();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeProviderMenu(true); });

// ---------- Evaluation ----------
function renderEvaluation() {
  const summary = telemetry.summary();
  $('#stRequests').textContent = summary.requests;
  $('#stLatency').textContent = summary.requests ? `${summary.avgLatency}ms` : '—';
  $('#stAvail').textContent = `${summary.successRate}%`;
  $('#stSpend').textContent = `$${summary.totalCost}`;
  $('#stRefusals').textContent = `${summary.refusals} (${summary.refusalRate}%)`;
  renderHealthChart(summary);
  const activity = $('#activity');
  activity.innerHTML = '';
  if (!telemetry.events.length) { activity.innerHTML = '<div class="event">No activity yet. Real requests appear here.</div>'; return; }
  for (const event of telemetry.events.slice(0, 25)) {
    const row = document.createElement('div');
    row.className = 'event';
    const parts = [new Date(event.ts).toLocaleTimeString(), event.ok ? '✅' : '❌', event.providerId, event.kind];
    if (event.category) parts.push(event.category);
    if (event.latencyMs != null) parts.push(`${event.latencyMs}ms`);
    if (event.usage?.totalTokens) parts.push(`${event.usage.totalTokens} tokens`);
    if (event.cost) parts.push(`$${event.cost}`);
    row.textContent = parts.join(' · ');
    activity.append(row);
  }
}

// ---------- Chat ----------
function addMessage(role, text, meta = '', { error = false, retry = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}${error ? ' error' : ''}`;
  const body = document.createElement('div');
  body.textContent = text;
  wrap.append(body);
  if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; wrap.append(m); }
  if (retry) {
    const button = document.createElement('button');
    button.className = 'btn'; button.textContent = 'Retry (same provider/model)';
    button.addEventListener('click', retry);
    wrap.append(button);
  }
  $('#messages').append(wrap);
  wrap.scrollIntoView({ block: 'end' });
  return wrap;
}
function setPendingText(node, text) { const body = node.firstChild; if (body.textContent === text) return; body.textContent = text; }

async function sendChat(rawText) {
  const text = rawText.trim();
  if (!text) return;
  if (lifecycle.active) return toast('A request is already running. Stop it first — SAVAGE will not queue or switch providers.', true);
  const provider = activeProvider();
  if (!provider || !provider.enabled) return toast('No active provider. Enable one — SAVAGE will not choose for you.', true);

  history.push({ role: 'user', content: text });
  addMessage('user', text);

  const controller = new AbortController();
  const request = lifecycle.begin(provider, { controller });
  const snapshot = request.provider; // frozen: later model edits cannot relabel this response
  const sendButton = $('#sendBtn');
  const stopButton = $('#stopBtn');
  stopButton.hidden = false; stopButton.disabled = false;
  sendButton.disabled = true; sendButton.textContent = 'Sending…';
  const pending = addMessage('assistant', streaming ? '' : 'Contacting provider…');
  try {
    if (proxyMode && store) provider.hasCredential = await store.has(provider.id).catch(() => false);
    const result = await runChat(provider, history, {
      stream: streaming,
      signal: controller.signal,
      onToken: (delta, full) => {
        // Late tokens from a cancelled or superseded request are ignored.
        if (lifecycle.isCurrent(request) && !controller.signal.aborted) setPendingText(pending, full);
      },
    });
    if (lifecycle.isStale(request)) { pending.remove(); return; }
    setPendingText(pending, result.responseText || '(empty response)');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const model = result.model || snapshot.model;
    const costLabel = result.cost == null ? '' : ` · $${result.cost}${result.costSource === 'estimated' ? ' (est.)' : result.costSource === 'reported' ? ' (reported)' : ''}`;
    meta.textContent = `${model} · ${result.latencyMs}ms${result.usage?.totalTokens ? ` · ${result.usage.totalTokens} tokens` : ''}${costLabel}${result.streamed ? ' · streamed' : ''}${result.complete === false ? ' · incomplete' : ''}${result.requestId ? ` · ${result.requestId}` : ''}`;
    pending.append(meta);
    history.push({ role: 'assistant', content: result.responseText });
    metrics[snapshot.id] = { latency: result.latencyMs, count: (metrics[snapshot.id]?.count || 0) + 1 };
    recordClientTelemetry(result, snapshot);
    if (result.warning) toast(result.warning, true);
    renderProviders();
  } catch (error) {
    if (controller.signal.aborted || lifecycle.isStale(request)) {
      pending.remove();
      addMessage('assistant', 'Stopped by you. Provider and model kept as selected — nothing was switched.');
      return;
    }
    const normalized = error instanceof NormalizedError ? error : normalizedFrom(error);
    pending.remove();
    addMessage('assistant', `⚠ ${CATEGORY_LABELS[normalized.category] || normalized.category}: ${normalized.message}\nProvider and model were kept as selected — nothing was switched.`, '', {
      error: true,
      retry: normalized.retryable || ['rate_limit', 'timeout', 'server_error', 'connection_error'].includes(normalized.category)
        ? () => { history.pop(); $('#chatInput').value = text; $('#chatForm').requestSubmit(); }
        : null,
    });
    recordClientTelemetry(null, snapshot, normalized);
  } finally {
    lifecycle.finish(request);
    stopButton.hidden = true; stopButton.disabled = false;
    sendButton.disabled = false; sendButton.textContent = 'Send';
    stopButton.textContent = 'Stop';
    renderEvaluation();
  }
}

function renderHealthChart(summary) {
  const chart = $('#healthChart');
  chart.innerHTML = '';
  const entries = Object.entries(summary.byProvider);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No provider health data yet. Real requests appear here.';
    chart.append(empty);
    return;
  }
  entries.sort((a, b) => b[1].length - a[1].length).forEach(([providerId, events]) => {
    const ok = events.filter(event => event.ok).length;
    const rate = events.length ? Math.round((ok / events.length) * 100) : 100;
    const avg = events.length ? Math.round(events.reduce((sum, event) => sum + (event.latencyMs || 0), 0) / events.length) : 0;
    const row = document.createElement('div');
    row.className = 'health-row';
    const head = document.createElement('div');
    head.className = 'health-head';
    const name = document.createElement('span'); name.textContent = providerId;
    const stat = document.createElement('span'); stat.textContent = `${rate}% · ${avg}ms · ${events.length} req`;
    head.append(name, stat);
    const bar = document.createElement('div'); bar.className = 'health-bar';
    const fill = document.createElement('div'); fill.className = 'health-fill'; fill.style.width = `${rate}%`;
    bar.append(fill);
    row.append(head, bar);
    chart.append(row);
  });
}

// ---------- Provider modal ----------
function openModal(provider = null) {
  editingId = provider?.id || null;
  modalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('#modalTitle').textContent = provider ? 'Edit provider' : 'Add provider';
  const form = $('#providerForm');
  form.reset();
  if (provider) {
    form.elements.name.value = provider.name;
    form.elements.adapter.value = provider.adapter;
    form.elements.endpoint.value = provider.endpoint || '';
    form.elements.model.value = provider.model || '';
    form.elements.apiKey.value = '';
    form.elements.customHeaders.value = provider.customHeaders || '';
    form.elements.inPrice.value = provider.pricing?.inputPer1M ?? '';
    form.elements.outPrice.value = provider.pricing?.outputPer1M ?? '';
  }
  form.elements.apiKey.disabled = !proxyMode;
  form.elements.apiKey.setAttribute('aria-describedby', 'apiKeyHint');
  $('#apiKeyHint').textContent = proxyMode
    ? (provider?.hasCredential ? 'A key is already stored server-side. Leave blank to keep it.' : 'Stored encrypted server-side; never returned to the browser.')
    : 'Server backend required. Keys are never stored in this browser.';
  $('#modal').classList.remove('hidden');
  form.elements.name.focus();
}
function closeModal() {
  $('#modal').classList.add('hidden');
  editingId = null;
  if (modalOpener?.isConnected) modalOpener.focus();
  modalOpener = null;
}
function modalFocusable() {
  return [...$('#modal').querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
}
function trapModalFocus(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
  if (event.key !== 'Tab') return;
  const items = modalFocusable();
  if (!items.length) return;
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

$('#addProvider').addEventListener('click', () => openModal());
$('#cancelModal').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (event) => { if (event.target.id === 'modal') closeModal(); });
$('#modal').addEventListener('keydown', trapModalFocus);

$('#providerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const pricing = (form.get('inPrice') || form.get('outPrice'))
    ? { inputPer1M: Number(form.get('inPrice')) || 0, outputPer1M: Number(form.get('outPrice')) || 0 }
    : null;
  const patched = {
    name: String(form.get('name') || '').trim(),
    adapter: String(form.get('adapter')),
    endpoint: String(form.get('endpoint') || '').trim(),
    model: String(form.get('model') || '').trim(),
    customHeaders: String(form.get('customHeaders') || '').trim(),
    pricing,
  };
  if (!patched.name) return toast('Provider name is required.', true);
  const key = String(form.get('apiKey') || '');
  let provider;
  if (editingId) {
    provider = providers.find(p => p.id === editingId);
    if (!provider) return closeModal();
    Object.assign(provider, patched);
  } else {
    provider = { id: `p-${Date.now().toString(36)}`, ...patched, enabled: true };
    providers.push(provider);
    activeId = provider.id;
  }
  try {
    if (proxyMode && store) {
      await store.set(provider.id, { secret: key || undefined, headers: patched.customHeaders ? patched.customHeaders : undefined });
      provider.hasCredential = await store.has(provider.id);
    } else if (key) {
      throw new Error('A server backend is required to store API keys. Start `node server.mjs` and reload — keys are never written to this browser.');
    }
    save(); closeModal(); render(); toast(`Provider saved: ${provider.name}`);
  } catch (error) {
    toast(`Could not save credentials: ${error.message}`, true);
  }
});

// ---------- Navigation & controls ----------
$('#providerSelect').addEventListener('change', (event) => {
  const wasRunning = Boolean(lifecycle.active);
  activeId = event.target.value;
  save(); render();
  if (wasRunning) toast('Provider changed. The running request keeps the provider and model it started with.');
});
$('#modelInput').addEventListener('change', (event) => {
  const provider = activeProvider();
  if (!provider) return;
  const wasRunning = Boolean(lifecycle.active);
  provider.model = event.target.value.trim();
  save(); render();
  toast(wasRunning ? 'Model changed. The running request keeps its original model.' : 'Model updated for this provider');
});
$('#streamToggle').addEventListener('click', (event) => {
  streaming = !streaming;
  event.currentTarget.textContent = `Streaming: ${streaming ? 'on' : 'off'}`;
  event.currentTarget.setAttribute('aria-pressed', String(streaming));
});
document.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('nav button, .view').forEach(el => el.classList.remove('active'));
  button.classList.add('active');
  $(`#view-${button.dataset.view}`).classList.add('active');
  renderEvaluation();
}));
$('#clearTelemetry').addEventListener('click', () => { telemetry.clear(); renderEvaluation(); toast('Local telemetry cleared'); });
$('#stopBtn').addEventListener('click', () => { const button = $('#stopBtn'); button.disabled = true; button.textContent = 'Stopping…'; lifecycle.abort(); });
$('#chatForm').addEventListener('submit', (event) => { event.preventDefault(); const input = $('#chatInput'); const text = input.value; input.value = ''; sendChat(text); });
$('#chatInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chatForm').requestSubmit(); }
});

await hydrateCredentials();
save();
render();
if (health?.warnings?.length) toast(health.warnings[0], true);
