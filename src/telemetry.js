export class Telemetry {
  constructor() { this.events = []; try { this.events = JSON.parse(localStorage.getItem('savage.telemetry') || '[]'); } catch {} }
  record(event) { this.events.unshift({ ts: Date.now(), ...event }); this.events = this.events.slice(0, 200); try { localStorage.setItem('savage.telemetry', JSON.stringify(this.events)); } catch {} }
  clear() { this.events = []; try { localStorage.removeItem('savage.telemetry'); } catch {} }
  summary() {
    const ev = this.events; const ok = ev.filter(e => e.ok).length;
    const refusals = ev.filter(e => e.category === 'provider_refusal').length;
    return { requests: ev.length, successRate: ev.length ? Math.round(ok / ev.length * 100) : 100, avgLatency: ev.length ? Math.round(ev.reduce((s, e) => s + (e.latencyMs || 0), 0) / ev.length) : 0, totalCost: Number(ev.reduce((s, e) => s + (e.cost || 0), 0).toFixed(6)), refusals, refusalRate: ev.length ? Math.round(refusals / ev.length * 100) : 0, byProvider: ev.reduce((m, e) => { (m[e.providerId] ||= []).push(e); return m; }, {}) };
  }
}
