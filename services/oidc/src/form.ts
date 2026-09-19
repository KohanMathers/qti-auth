const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;
const BASIC = /^Basic[ \t]+([A-Za-z0-9+/=]+)$/i;

export function isFormRequest(request: Request): boolean {
  return FORM_CONTENT_TYPE.test(request.headers.get('content-type') ?? '');
}

export async function readForm(request: Request): Promise<Record<string, string>> {
  if (!isFormRequest(request)) return {};
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

export interface ClientCredentials {
  client_id: string;
  client_secret: string | undefined;
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll('+', '%20'));
  } catch {
    return value;
  }
}

export function basicCredentials(request: Request): ClientCredentials | undefined {
  const header = request.headers.get('authorization');
  if (header === null) return undefined;
  const match = BASIC.exec(header);
  if (match?.[1] === undefined) return undefined;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  return {
    client_id: decodeComponent(decoded.slice(0, colon)),
    client_secret: decodeComponent(decoded.slice(colon + 1)),
  };
}

export function presentedCredentials(
  request: Request,
  form: Record<string, string>,
): ClientCredentials | undefined {
  const basic = basicCredentials(request);
  const bodyId = form['client_id'];
  const bodySecret = form['client_secret'];
  if (basic) {
    if (bodyId !== undefined && bodyId !== basic.client_id) return undefined;
    return basic;
  }
  if (bodyId === undefined || bodyId === '') return undefined;
  return { client_id: bodyId, client_secret: bodySecret };
}
