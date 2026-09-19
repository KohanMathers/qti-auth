import type { Router } from '@qtiauth/service-kit';

import {
  decideDeviceAuthorization,
  displayUserCode,
  loadDeviceAuthorization,
  normalizeUserCode,
} from './device.ts';
import { readForm } from './form.ts';
import { escapeHtml, hiddenInput, htmlResponse } from './html.ts';
import { decideConsent, loadAuthorizationRequest } from './oauth.ts';
import type { Context } from './service.ts';
import { CONSENT_PATH, DEVICE_PATH } from './settings.ts';

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
      const unverified = client.verified || client.first_party ? '' : `<p>Unverified app</p>`;
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

function deviceEnterForm(userCode = ''): string {
  return `<form method="post" action="device">
<p><label>Code <input name="user_code" value="${escapeHtml(userCode)}" autocomplete="one-time-code" required></label></p>
<p><button type="submit">Continue</button></p>
</form>`;
}

function unknownDevice(ctx: Context): Response {
  return page(ctx, {
    status: 400,
    title: 'Unknown code',
    body: `<p>This code is unknown, has expired or has already been used.</p>
${deviceEnterForm()}`,
  });
}

export function deviceRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: DEVICE_PATH,
    operation_id: 'devicePage',
    summary: 'Enter or confirm a device-flow user code',
    description: 'Interim page until the web app replaces it.',
    tags: ['pages'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    responses: htmlResponses,
    handler: async ({ ctx, request }) => {
      const presented = new URL(request.url).searchParams.get('user_code') ?? '';
      if (presented === '') {
        return page(ctx, {
          title: 'Sign in on your device',
          body: `<p>Enter the code shown on your device.</p>
${deviceEnterForm()}`,
        });
      }
      const loaded = await loadDeviceAuthorization(ctx, presented);
      if (!loaded) return unknownDevice(ctx);
      const { client, row } = loaded;
      const normalized = normalizeUserCode(presented);
      const userCode = normalized === undefined ? presented : displayUserCode(normalized);
      const scopes = row.scopes
        .map((scope) => {
          const text = ctx.config.oidc.scopes[scope]?.consent ?? scope;
          return `<li>${escapeHtml(text)}</li>`;
        })
        .join('');
      const unverified = client.verified || client.first_party ? '' : `<p>Unverified app</p>`;
      return page(ctx, {
        title: `Authorize ${client.name}`,
        body: `${unverified}<p>Code ${escapeHtml(userCode)}. ${escapeHtml(client.name)} wants to:</p>
<ul>${scopes}</ul>
<form method="post" action="device">
${hiddenInput('user_code', userCode)}
${hiddenInput('decision', 'allow')}
<p><button type="submit">Allow</button></p>
</form>
<form method="post" action="device">
${hiddenInput('user_code', userCode)}
${hiddenInput('decision', 'deny')}
<p><button type="submit">Deny</button></p>
</form>`,
      });
    },
  });

  router.route({
    method: 'POST',
    path: DEVICE_PATH,
    operation_id: 'deviceDecide',
    summary: 'Allow or deny a device authorization request',
    tags: ['pages'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    responses: {
      ...htmlResponses,
      302: { description: 'Redirect to the confirmation page' },
    },
    handler: async ({ ctx, identity, request }) => {
      const form = await readForm(request);
      if (form['decision'] === undefined) {
        const normalized = normalizeUserCode(form['user_code'] ?? '');
        const userCode =
          normalized === undefined ? (form['user_code'] ?? '') : displayUserCode(normalized);
        return new Response(null, {
          status: 302,
          headers: { location: `/oauth/device?user_code=${encodeURIComponent(userCode)}` },
        });
      }
      const result = await decideDeviceAuthorization(ctx, identity, form);
      if (result.status === 'not_found') return unknownDevice(ctx);
      if (result.status === 'denied') {
        return page(ctx, {
          title: 'Request denied',
          body: `<p>You can close this page. Your device will not be signed in.</p>`,
        });
      }
      return page(ctx, {
        title: 'Device signed in',
        body: `<p>You can return to your device.</p>`,
      });
    },
  });
}
