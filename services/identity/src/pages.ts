import type { Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { isValidDateOfBirth } from './age.ts';
import { magicLinkEnabled, signup, verify } from './flows.ts';
import { sessionHeaders } from './headers.ts';
import { escapeHtml, hiddenInput, type HtmlPage, htmlResponse } from './html.ts';
import type { CreatedSession } from './sessions.ts';
import type { Context } from './service.ts';
import { accountPath, MAGIC_LINK_PAGE } from './settings.ts';

export const SIGNUP_PAGE = '/auth/signup';

const htmlResponses = { 200: { description: 'An HTML page' } };

type Page = Omit<HtmlPage, 'product'>;

const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;

async function readForm(request: Request): Promise<Record<string, string>> {
  if (!FORM_CONTENT_TYPE.test(request.headers.get('content-type') ?? '')) return {};
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function page(ctx: Context, content: Page): Response {
  return htmlResponse({ ...content, product: ctx.config.branding.product_name });
}

function paragraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

function disabled(ctx: Context): Response {
  return page(ctx, {
    status: 403,
    title: 'Magic links are turned off',
    body: paragraph('Sign in another way.'),
  });
}

function invalidLink(ctx: Context): Response {
  return page(ctx, {
    status: 400,
    title: 'This link can’t be used',
    body: paragraph('It has expired or has already been used. Ask for a new link to sign in.'),
  });
}

function dateOfBirthForm(ctx: Context, signupToken: string, error?: string): Response {
  return page(ctx, {
    status: error === undefined ? 200 : 400,
    title: 'Create your account',
    body: `${error === undefined ? '' : `<p role="alert">${escapeHtml(error)}</p>`}
<form method="post" action="signup">
${hiddenInput('signup_token', signupToken)}
<p><label for="date_of_birth">Date of birth</label><br>
<input id="date_of_birth" name="date_of_birth" type="date" required></p>
<p><button type="submit">Create account</button></p>
</form>`,
  });
}

function signedIn(ctx: Context, session: CreatedSession, returnTo: string | null): Response {
  const headers = sessionHeaders(session);
  if (returnTo !== null) {
    return new Response(null, {
      status: 303,
      headers: { ...headers, location: accountPath(ctx.config, returnTo) },
    });
  }
  return page(ctx, {
    title: 'You’re signed in',
    headers,
    body: `<ul>
<li><a href="../api/v1/me">Your account</a></li>
<li><a href="../api/v1/sessions">Your sessions</a></li>
</ul>
<form method="post" action="../api/v1/auth/logout"><button type="submit">Sign out</button></form>`,
  });
}

export function pageRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: MAGIC_LINK_PAGE,
    operation_id: 'magicLinkPage',
    summary: 'Page asking to confirm a magic-link sign-in',
    description:
      'Opening a magic link only shows this page, so email scanners that follow links don’t use them up. Interim page until the web app replaces it.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'global',
    request: { query: z.object({ token: z.string().max(256).optional() }) },
    responses: htmlResponses,
    handler: ({ ctx, query }) => {
      if (!magicLinkEnabled(ctx)) return Promise.resolve(disabled(ctx));
      if (query.token === undefined) return Promise.resolve(invalidLink(ctx));
      return Promise.resolve(
        page(ctx, {
          title: `Sign in to ${ctx.config.branding.product_name}`,
          body: `<form method="post" action="magic-link">
${hiddenInput('token', query.token)}
<p><button type="submit">Continue</button></p>
</form>`,
        }),
      );
    },
  });

  router.route({
    method: 'POST',
    path: MAGIC_LINK_PAGE,
    operation_id: 'magicLinkPageConfirm',
    summary: 'Confirm a magic-link sign-in from the confirmation page',
    description: 'Takes a form with token and, after choosing an account, user_id.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log }) => {
      if (!magicLinkEnabled(ctx)) return disabled(ctx);
      const form = await readForm(request);
      const token = form['token'] ?? '';
      const userId = form['user_id'];
      const result = await verify(
        { ctx, request, log },
        { token, userId: z.uuid().safeParse(userId).success ? userId : undefined },
      );
      switch (result.status) {
        case 'invalid':
          return invalidLink(ctx);
        case 'signup_required':
          return dateOfBirthForm(ctx, result.signupToken);
        case 'signed_in':
          return signedIn(ctx, result.session, result.returnTo);
        case 'choose_account':
          return page(ctx, {
            title: 'Choose an account',
            body: `<form method="post" action="magic-link">
${hiddenInput('token', token)}
${result.accounts
  .map(
    (account, index) =>
      `<p><label><input type="radio" name="user_id" value="${escapeHtml(account.id)}" required${index === 0 ? ' checked' : ''}> Account created ${escapeHtml(account.created_at.toISOString().slice(0, 10))}</label></p>`,
  )
  .join('\n')}
<p><button type="submit">Continue</button></p>
</form>`,
          });
      }
    },
  });

  router.route({
    method: 'POST',
    path: SIGNUP_PAGE,
    operation_id: 'signupPage',
    summary: 'Create an account from the date of birth page',
    description: 'Takes a form with signup_token and date_of_birth.',
    tags: ['pages'],
    auth: 'none',
    rate_limit: 'auth_verify',
    responses: { ...htmlResponses, 303: { description: 'Signed in, going to return_to' } },
    handler: async ({ ctx, request, log }) => {
      if (!magicLinkEnabled(ctx)) return disabled(ctx);
      const form = await readForm(request);
      const signupToken = form['signup_token'] ?? '';
      const dateOfBirth = form['date_of_birth'] ?? '';
      if (!isValidDateOfBirth(dateOfBirth, new Date())) {
        return dateOfBirthForm(ctx, signupToken, 'Enter your real date of birth.');
      }
      const result = await signup({ ctx, request, log }, { signupToken, dateOfBirth });
      switch (result.status) {
        case 'invalid':
          return invalidLink(ctx);
        case 'account_limit':
          return page(ctx, {
            status: 409,
            title: 'You can’t create another account',
            body: paragraph('This email address already has as many accounts as it can have.'),
          });
        case 'parental_consent_required':
          return page(ctx, {
            status: 403,
            title: 'You can’t create an account yet',
            body: paragraph(
              `People under ${String(ctx.config.parental.consent_age)} need a parent or guardian to approve their account, and that isn’t available yet.`,
            ),
          });
        case 'signed_in':
          return signedIn(ctx, result.session, result.returnTo);
      }
    },
  });
}
