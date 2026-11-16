import { NormalizedError } from './errors.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const LOOPBACK_ALLOWLIST = ['localhost', '127.0.0.1'];

// Allowlisting per adapter. Providers you add must be explicitly allowlisted
// here or via SAVAGE_ALLOWED_HOSTS — arbitrary proxy URLs are refused.
export const ADAPTER_HOST_ALLOWLIST = {
  huggingface: ['router.huggingface.co', 'api-inference.huggingface.co'],
  venice: ['api.venice.ai'],
  'openai-compatible': [],
  'custom-openai': LOOPBACK_ALLOWLIST,
};

export function isPrivateAddress(ip) {
  const value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (value === '::1' || value === '::') return true;
  if (/^(fc|fd|fe80)/.test(value)) return true; // unique-local / link-local v6
  if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // metadata / link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function hostAllowed(hostname, { adapter, allowedHosts = [] } = {}) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const list = [...(ADAPTER_HOST_ALLOWLIST[adapter] || []), ...allowedHosts.map(h => String(h).toLowerCase())];
  return list.some(entry => entry && (host === entry || host.endsWith(`.${entry}`)));
}

export function assertEndpointUrl(endpoint, { adapter, allowedHosts = [], allowLoopback = false } = {}) {
  let url;
  try { url = new URL(String(endpoint)); } catch { throw new NormalizedError({ category: 'invalid_request', message: 'Provider endpoint is not a valid URL.' }); }
  if (url.username || url.password) throw new NormalizedError({ category: 'invalid_request', message: 'Credentials in endpoint URLs are not allowed.' });
  if (!['https:', 'http:'].includes(url.protocol)) throw new NormalizedError({ category: 'invalid_request', message: 'Endpoint must use HTTPS (HTTP only for local development).' });
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopbackHost = LOOPBACK_HOSTS.has(host);
  if (isLoopbackHost && !allowLoopback) throw new NormalizedError({ category: 'invalid_request', message: 'Loopback endpoints are disabled on this server.' });
  if (url.protocol === 'http:' && !(allowLoopback && isLoopbackHost)) {
    throw new NormalizedError({ category: 'invalid_request', message: 'Plain HTTP endpoints are refused except loopback in development.' });
  }
  if (!isLoopbackHost && isPrivateAddress(host)) throw new NormalizedError({ category: 'invalid_request', message: 'Private / link-local addresses are refused (SSRF protection).' });
  if (!hostAllowed(host, { adapter, allowedHosts })) {
    throw new NormalizedError({ category: 'invalid_request', message: `Host "${host}" is not allowlisted for adapter "${adapter}".` });
  }
  return url;
}

export async function assertEndpointResolvesSafely(url, { lookup, allowLoopback = false } = {}) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host)) {
    if (!allowLoopback) throw new NormalizedError({ category: 'invalid_request', message: 'Loopback endpoints are disabled on this server.' });
    return;
  }
  if (typeof lookup !== 'function') return; // caller explicitly opts out (documented limitation)
  let addresses;
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch {
    throw new NormalizedError({ category: 'connection_error', message: `Could not resolve provider host "${host}".` });
  }
  const list = Array.isArray(addresses) ? addresses : [{ address: addresses?.address }];
  for (const entry of list) {
    if (entry?.address && isPrivateAddress(entry.address)) {
      throw new NormalizedError({ category: 'invalid_request', message: `Provider host "${host}" resolves to a private address (SSRF protection).` });
    }
  }
}
