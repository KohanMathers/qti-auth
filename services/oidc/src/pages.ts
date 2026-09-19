import type { Router } from '@qtiauth/service-kit';

import { readForm } from './form.ts';
import { escapeHtml, hiddenInput, htmlResponse } from './html.ts';
import { decideConsent, loadAuthorizationRequest } from './oauth.ts';
import type { Context } from './service.ts';
import { CONSENT_PATH } from './settings.ts';

const htmlResponses = { 200: { description: 'An HTML page' } };

function page(ctx: Context, content: { title: string; body: string; status?: number }): Response {
  return htmlResponse({ ...content, product: ctx.config.branding.product_name });
}

function unknownRequest(ctx: Context): Response {
  return page(ctx, {
    status: 400,
    title: 'Authorization expired',
    body: `<p>This authorization request is unknown, has expired or has already been used.</p>`,
  });
}

export function consentRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: CONSENT_PATH,
    operation_id: 'consentPage',
    summary: 'Ask the signed-in user to authorize an OAuth client',
    description: 'Interim page until the web app replaces it.',
    tags: ['pages'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    responses: htmlResponses,
    handler: async ({ ctx, identity, request }) => {
      const requestId = new URL(request.url).searchParams.get('request_id') ?? '';
      const loaded = await loadAuthorizationRequest(ctx, identity, requestId);
      if (!loaded) return unknownRequest(ctx);
      const { client, row } = loaded;
      const scopes = row.scopes
        .map((scope) => {
          const text = ctx.config.oidc.scopes[scope]?.consent ?? scope;
          return `<li>${escapeHtml(text)}</li>`;
        })
        .join('');
      const unverified =
        client.verified || client.first_party ? '' : `<p>This app is not verified.</p>`;
      return page(ctx, {
        title: `Authorize ${client.name}`,
        body: `${unverified}<p>${escapeHtml(client.name)} wants to:</p>
<ul>${scopes}</ul>
<form method="post" action="consent">
${hiddenInput('request_id', requestId)}
${hiddenInput('decision', 'allow')}
<p><button type="submit">Allow</button></p>
</form>
<form method="post" action="consent">
${hiddenInput('request_id', requestId)}
${hiddenInput('decision', 'deny')}
<p><button type="submit">Deny</button></p>
</form>`,
      });
    },
  });

  router.route({
    method: 'POST',
    path: CONSENT_PATH,
    operation_id: 'consentDecide',
    summary: 'Allow or deny an OAuth authorization request',
    tags: ['pages'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    responses: {
      ...htmlResponses,
      302: { description: 'Redirect to the client' },
    },
    handler: async ({ ctx, identity, request }) => {
      const result = await decideConsent(ctx, identity, await readForm(request));
      if (result.status === 'not_found') return unknownRequest(ctx);
      return result;
    },
  });
}
