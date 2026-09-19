function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function parseRedirectUri(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.hash !== '') return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function redirectsMatch(registered: readonly string[], requested: string): boolean {
  const request = parseRedirectUri(requested);
  if (!request) return false;
  return registered.some((entry) => {
    const allowed = parseRedirectUri(entry);
    if (!allowed) return false;
    if (allowed.protocol !== request.protocol) return false;
    if (allowed.hostname !== request.hostname) return false;
    if (allowed.pathname !== request.pathname) return false;
    if (allowed.search !== request.search) return false;
    if (isLoopbackHost(allowed.hostname) && allowed.protocol === 'http:') return true;
    return allowed.port === request.port;
  });
}
