import { NormalizedError } from './errors.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
const LOOPBACK_ALLOWLIST = ['localhost', '127.0.0.1', '::1'];

// Allowlisting per adapter. Providers you add must be explicitly allowlisted
// here or via SAVAGE_ALLOWED_HOSTS — arbitrary proxy URLs are refused.
export const ADAPTER_HOST_ALLOWLIST = {
  huggingface: ['router.huggingface.co', 'api-inference.huggingface.co'],
  venice: ['api.venice.ai'],
  'openai-compatible': [],
  'custom-openai': LOOPBACK_ALLOWLIST,
};

export function isPrivateAddress(ip) {
  let value = String(ip || '').toLowerCase().trim().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone); // IPv6 zone id: fe80::1%eth0
  if (!value) return false;
  return value.includes(':') ? isPrivateIpv6(value) : isPrivateIpv4(value);
}

function isPrivateIpv4(value) {
  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if (a > 255 || b > 255) return false;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // metadata / link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

const hextetsToIpv4 = (hiHex, loHex) => {
  const hi = parseInt(hiHex, 16); const lo = parseInt(loHex, 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
};

function isPrivateIpv6(value) {
  if (value === '::1' || value === '::') return true;
  // IPv4-mapped (dotted and hex forms) and IPv4-compatible.
  const mappedDotted = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1]);
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) return isPrivateIpv4(hextetsToIpv4(mappedHex[1], mappedHex[2]));
  const compatible = value.match(/^::(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (compatible) return isPrivateIpv4(compatible[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(value)) return true; // fe80::/10 link local
  const sixToFour = value.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
  if (sixToFour) return isPrivateIpv4(hextetsToIpv4(sixToFour[1], sixToFour[2]));
  return false;
}

export function hostAllowed(hostname, { adapter, allowedHosts = [] } = {}) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const list = [...(ADAPTER_HOST_ALLOWLIST[adapter] || []), ...allowedHosts.map(h => String(h).toLowerCase().replace(/^\./, ''))];
  // Suffix matches must sit on a label boundary: example.com must not allow
  // notexample.com or example.com.attacker.net.
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

// DNS rebinding remains a documented limitation: this resolves the hostname, but
// the outbound connection resolves it again. Dependency-free Node cannot pin the
// address for fetch without a custom dispatcher, so production deployments must
// pin addresses or egress through an enforcing proxy.
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
