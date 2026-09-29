import {
  admin,
  apiClient,
  auth,
  family,
  games,
  guestSupport,
  kb,
  me,
  oauth,
  ProblemFetchError,
  reports,
  sessions,
  staffKb,
  staffSupport,
  support,
} from './client.js';
import { messageFor } from './problems.js';

export function element(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'attrs') for (const [k, v] of Object.entries(value)) node.setAttribute(k, v);
    else node[key] = value;
  }
  for (const child of children) if (child !== null) node.appendChild(child);
  return node;
}

export function clear(node) {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

function field(t, spec) {
  const id = `qtiauth-f-${spec.name}`;
  const label = element('label', { htmlFor: id, text: t(spec.label, spec.name) });
  const input = element('input', {
    id,
    name: spec.name,
    type: spec.type ?? 'text',
    required: spec.required !== false,
    autocomplete: spec.autocomplete ?? 'off',
  });
  if (spec.value !== undefined) input.value = spec.value;
  if (spec.min !== undefined) input.minLength = spec.min;
  if (spec.pattern !== undefined) input.pattern = spec.pattern;
  const wrap = element('p', { className: 'qtiauth-field' });
  wrap.append(label, input);
  return { wrap, input };
}

function submitRow(t, label) {
  const row = element('p', { className: 'qtiauth-actions' });
  row.appendChild(element('button', { type: 'submit', text: t(label, 'Submit') }));
  return row;
}

function successRow(t, label) {
  return element('p', {
    className: 'qtiauth-success',
    attrs: { role: 'status' },
    text: t(label, 'Done.'),
  });
}

function problemAlert(t, problem) {
  const catalogueEntry = messageFor(problem.code ?? 'INTERNAL_ERROR');
  const box = element('div', {
    className: 'qtiauth-alert',
    attrs: { role: 'alert' },
  });
  box.append(
    element('h2', { text: t(`problems.${problem.code}.title`, catalogueEntry.title) }),
    element('p', {
      text: problem.detail ?? t(`problems.${problem.code}.detail`, catalogueEntry.detail),
    }),
  );
  return box;
}

async function runForm(form, feedback, t, action) {
  form.setAttribute('aria-busy', 'true');
  clear(feedback);
  try {
    const result = await action();
    form.setAttribute('aria-busy', 'false');
    return result;
  } catch (error) {
    form.setAttribute('aria-busy', 'false');
    const problem = error instanceof ProblemFetchError ? error.problem : { code: 'INTERNAL_ERROR' };
    feedback.appendChild(problemAlert(t, problem));
    return undefined;
  }
}

function heading(main, t, titleKey, fallback, description) {
  main.appendChild(element('h2', { text: t(titleKey, fallback) }));
  if (description !== undefined) {
    main.appendChild(element('p', { className: 'qtiauth-lede', text: t(description, '') }));
  }
}

function form(fields, t, submitLabel, onSubmit) {
  const feedback = element('div', {
    className: 'qtiauth-feedback',
    attrs: { 'aria-live': 'polite' },
  });
  const el = element('form', { noValidate: true });
  const inputs = new Map();
  for (const spec of fields) {
    const { wrap, input } = field(t, spec);
    el.appendChild(wrap);
    inputs.set(spec.name, input);
  }
  el.appendChild(submitRow(t, submitLabel));
  el.appendChild(feedback);
  el.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const [name, input] of inputs) values[name] = input.value;
    void runForm(el, feedback, t, () => onSubmit(values, { form: el, feedback }));
  });
  return el;
}

function list(items, render) {
  const ul = element('ul', { className: 'qtiauth-list' });
  for (const item of items) ul.appendChild(render(item));
  return ul;
}

function empty(t, key, fallback) {
  return element('p', { className: 'qtiauth-empty', text: t(key, fallback) });
}

function socialButtons(t, features, ctx) {
  if (features.auth.social.length === 0) return null;
  const wrap = element('div', { className: 'qtiauth-social' });
  wrap.appendChild(element('h3', { text: t('signIn.social', 'Continue with') }));
  const buttons = element('ul', { className: 'qtiauth-social-list' });
  for (const provider of features.auth.social) {
    const anchor = element('a', {
      href: `${ctx.apiBase}/api/v1/auth/social/${encodeURIComponent(provider.id)}/start`,
      className: 'qtiauth-button qtiauth-button-social',
      text: provider.name,
    });
    const item = element('li');
    item.appendChild(anchor);
    buttons.appendChild(item);
  }
  wrap.appendChild(buttons);
  return wrap;
}

function pageSignIn(main, t, ctx) {
  heading(main, t, 'routes.sign-in.title', 'Sign in', 'signIn.lede');
  const a = auth(ctx.api);
  if (ctx.features.auth.methods.password) {
    main.appendChild(
      element('h3', { text: t('signIn.password.heading', 'Sign in with password') }),
    );
    main.appendChild(
      form(
        [
          { name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' },
          {
            name: 'password',
            type: 'password',
            label: 'field.password',
            autocomplete: 'current-password',
          },
        ],
        t,
        'signIn.submit',
        async (values, { feedback }) => {
          await a.signInPassword(values.email, values.password);
          feedback.appendChild(successRow(t, 'signIn.success'));
          ctx.navigate('/account');
        },
      ),
    );
    main.appendChild(
      element('p', {}, [
        element('a', {
          href: ctx.href('/forgot'),
          text: t('signIn.forgot', 'Forgot your password?'),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate('/forgot');
          },
        }),
      ]),
    );
  }
  if (ctx.features.auth.methods.magic_link) {
    main.appendChild(element('h3', { text: t('signIn.magic.heading', 'Sign in with a link') }));
    main.appendChild(
      form(
        [{ name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' }],
        t,
        'signIn.magic.submit',
        async (values, { feedback }) => {
          await a.magicLinkStart(values.email);
          feedback.appendChild(successRow(t, 'signIn.magic.success'));
        },
      ),
    );
  }
  if (ctx.features.auth.methods.passkeys) {
    main.appendChild(
      element('h3', { text: t('signIn.passkey.heading', 'Sign in with a passkey') }),
    );
    main.appendChild(
      element('p', {
        text: t('signIn.passkey.body', 'Your device will prompt you to choose a passkey.'),
      }),
    );
    main.appendChild(
      element('button', {
        type: 'button',
        text: t('signIn.passkey.submit', 'Use a passkey'),
        onclick: () => {
          const feedback =
            main.querySelector('.qtiauth-feedback') ??
            main.appendChild(element('div', { className: 'qtiauth-feedback' }));
          feedback.appendChild(
            element('p', { text: t('signIn.passkey.pending', 'Passkey sign-in is coming soon.') }),
          );
        },
      }),
    );
  }
  const social = socialButtons(t, ctx.features, ctx);
  if (social !== null) main.appendChild(social);
  main.appendChild(
    element('p', {}, [
      element('a', {
        href: ctx.href('/sign-up'),
        text: t('signIn.newHere', 'Create an account'),
        onclick: (event) => {
          event.preventDefault();
          ctx.navigate('/sign-up');
        },
      }),
    ]),
  );
}

function pageSignUp(main, t, ctx) {
  heading(main, t, 'routes.sign-up.title', 'Create an account', 'signUp.lede');
  const a = auth(ctx.api);
  if (ctx.features.auth.methods.password) {
    main.appendChild(
      form(
        [
          { name: 'name', label: 'field.name', autocomplete: 'name' },
          { name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' },
          {
            name: 'password',
            type: 'password',
            label: 'field.password',
            autocomplete: 'new-password',
            min: 12,
          },
        ],
        t,
        'signUp.submit',
        async (values, { feedback }) => {
          await a.signUpPassword(values.email, values.password, values.name);
          feedback.appendChild(successRow(t, 'signUp.success'));
          ctx.navigate('/verify');
        },
      ),
    );
  }
  if (ctx.features.auth.methods.magic_link && !ctx.features.auth.methods.password) {
    main.appendChild(
      form(
        [
          { name: 'name', label: 'field.name', autocomplete: 'name' },
          { name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' },
        ],
        t,
        'signUp.magic.submit',
        async (values, { feedback }) => {
          await a.magicLinkStart(values.email);
          feedback.appendChild(successRow(t, 'signUp.magic.success'));
        },
      ),
    );
  }
}

function pageVerify(main, t, ctx) {
  heading(main, t, 'routes.verify.title', 'Verify your email', 'verify.lede');
  const a = auth(ctx.api);
  const token = new URLSearchParams(ctx.location.search).get('token') ?? '';
  main.appendChild(
    form(
      [
        {
          name: 'token',
          label: 'field.token',
          autocomplete: 'one-time-code',
          value: token,
        },
      ],
      t,
      'verify.submit',
      async (values, { feedback }) => {
        await a.verifyEmail(values.token);
        feedback.appendChild(successRow(t, 'verify.success'));
        ctx.navigate('/account');
      },
    ),
  );
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-ghost',
      text: t('verify.resend', 'Send a new email'),
      onclick: () => {
        void a.startVerifyEmail();
      },
    }),
  );
}

function pageForgot(main, t, ctx) {
  heading(main, t, 'routes.forgot.title', 'Reset your password', 'forgot.lede');
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [{ name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' }],
      t,
      'forgot.submit',
      async (values, { feedback }) => {
        await a.forgot(values.email);
        feedback.appendChild(successRow(t, 'forgot.success'));
      },
    ),
  );
}

function pageReset(main, t, ctx) {
  heading(main, t, 'routes.reset.title', 'Choose a new password', 'reset.lede');
  const a = auth(ctx.api);
  const token = new URLSearchParams(ctx.location.search).get('token') ?? '';
  main.appendChild(
    form(
      [
        { name: 'token', label: 'field.token', autocomplete: 'one-time-code', value: token },
        {
          name: 'password',
          type: 'password',
          label: 'field.password',
          autocomplete: 'new-password',
          min: 12,
        },
      ],
      t,
      'reset.submit',
      async (values, { feedback }) => {
        await a.reset(values.token, values.password);
        feedback.appendChild(successRow(t, 'reset.success'));
        ctx.navigate('/sign-in');
      },
    ),
  );
}

function pageGuardianApprove(main, t, ctx) {
  heading(main, t, 'routes.guardian.approve.title', 'Approve this account', 'guardian.approve.lede');
  const token = new URLSearchParams(ctx.location.search).get('token') ?? '';
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'token', label: 'field.token', value: token },
        { name: 'date_of_birth', type: 'date', label: 'field.dateOfBirth' },
      ],
      t,
      'guardian.approve.submit',
      async (values, { feedback }) => {
        await a.guardianApprove(values.token, values.date_of_birth);
        feedback.appendChild(successRow(t, 'guardian.approve.success'));
      },
    ),
  );
}

function pageGuardianDecline(main, t, ctx) {
  heading(main, t, 'routes.guardian.decline.title', 'Decline this account', 'guardian.decline.lede');
  const token = new URLSearchParams(ctx.location.search).get('token') ?? '';
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [{ name: 'token', label: 'field.token', value: token }],
      t,
      'guardian.decline.submit',
      async (values, { feedback }) => {
        await a.guardianDecline(values.token);
        feedback.appendChild(successRow(t, 'guardian.decline.success'));
      },
    ),
  );
}

function pageFamilySession(main, t, ctx) {
  heading(main, t, 'routes.family.session.title', 'Open the family dashboard', 'family.session.lede');
  const token = new URLSearchParams(ctx.location.search).get('token') ?? '';
  const f = family(ctx.api);
  main.appendChild(
    form(
      [{ name: 'token', label: 'field.token', value: token }],
      t,
      'family.session.submit',
      async (values, { feedback }) => {
        await f.openSession(values.token);
        feedback.appendChild(successRow(t, 'family.session.success'));
        ctx.navigate('/family');
      },
    ),
  );
}

function pageFamilyInvite(main, t, ctx) {
  heading(main, t, 'routes.family.invite.title', 'Become a parent or guardian', 'family.invite.lede');
  const token = new URLSearchParams(ctx.location.search).get('token') ?? '';
  const f = family(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'token', label: 'field.token', value: token },
        { name: 'date_of_birth', type: 'date', label: 'field.dateOfBirth' },
      ],
      t,
      'family.invite.submit',
      async (values, { feedback }) => {
        await f.acceptInvite(values.token, values.date_of_birth);
        feedback.appendChild(successRow(t, 'family.invite.success'));
      },
    ),
  );
}

function pageRevertEmail(main, t, ctx) {
  heading(main, t, 'routes.revert.title', 'Revert email change', 'revert.lede');
  const token = new URLSearchParams(ctx.location.search).get('token') ?? '';
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [{ name: 'token', label: 'field.token', value: token }],
      t,
      'revert.submit',
      async (values, { feedback }) => {
        await a.revertEmail(values.token);
        feedback.appendChild(successRow(t, 'revert.success'));
      },
    ),
  );
}

function pageAccount(main, t, ctx) {
  heading(main, t, 'routes.account.title', 'Your account', 'routes.account.body');
  const sections = [
    { path: '/account/profile', label: 'account.section.profile' },
    { path: '/account/email', label: 'account.section.email' },
    { path: '/account/security', label: 'account.section.security' },
    { path: '/account/sessions', label: 'account.section.sessions' },
    { path: '/account/methods', label: 'account.section.methods' },
    { path: '/account/notifications', label: 'account.section.notifications' },
    { path: '/account/legal', label: 'account.section.legal' },
    { path: '/account/data', label: 'account.section.data' },
  ];
  main.appendChild(
    list(sections, (section) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(section.path),
          text: t(section.label, section.path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(section.path);
          },
        }),
      );
      return item;
    }),
  );
  const a = auth(ctx.api);
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-ghost',
      text: t('account.signOut', 'Sign out'),
      onclick: () => {
        void a.signOut().then(() => ctx.navigate('/sign-in'));
      },
    }),
  );
}

function pageProfile(main, t, ctx) {
  heading(main, t, 'routes.profile.title', 'Profile', 'profile.lede');
  const account = me(ctx.api);
  const details = element('dl', { className: 'qtiauth-details' });
  main.appendChild(details);
  void account
    .get()
    .then((data) => {
      const entries = [
        ['profile.field.name', data?.name ?? ''],
        ['profile.field.username', data?.username ?? ''],
        ['profile.field.email', data?.email ?? ''],
      ];
      for (const [key, value] of entries) {
        details.append(element('dt', { text: t(key, key) }), element('dd', { text: value }));
      }
    })
    .catch(() => {
      details.appendChild(
        element('dd', { text: t('profile.load.error', 'Could not load profile.') }),
      );
    });
  main.appendChild(element('h3', { text: t('profile.username.heading', 'Change username') }));
  main.appendChild(
    form(
      [{ name: 'username', label: 'field.username', autocomplete: 'username' }],
      t,
      'profile.username.submit',
      async (values, { feedback }) => {
        await account.setUsername(values.username);
        feedback.appendChild(successRow(t, 'profile.username.success'));
      },
    ),
  );
}

function pageEmail(main, t, ctx) {
  heading(main, t, 'routes.email.title', 'Change email', 'email.lede');
  const a = auth(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'email', type: 'email', label: 'field.email.new', autocomplete: 'email' },
        {
          name: 'password',
          type: 'password',
          label: 'field.password',
          autocomplete: 'current-password',
        },
      ],
      t,
      'email.submit',
      async (values, { feedback }) => {
        await a.changeEmail(values.email, values.password);
        feedback.appendChild(successRow(t, 'email.success'));
      },
    ),
  );
}

function pageSecurity(main, t, ctx) {
  heading(main, t, 'routes.security.title', 'Security', 'security.lede');
  const a = auth(ctx.api);
  main.appendChild(element('h3', { text: t('security.password.heading', 'Change password') }));
  main.appendChild(
    form(
      [
        {
          name: 'current',
          type: 'password',
          label: 'field.password.current',
          autocomplete: 'current-password',
        },
        {
          name: 'next',
          type: 'password',
          label: 'field.password.new',
          autocomplete: 'new-password',
          min: 12,
        },
      ],
      t,
      'security.password.submit',
      async (values, { feedback }) => {
        await a.changePassword(values.current, values.next);
        feedback.appendChild(successRow(t, 'security.password.success'));
      },
    ),
  );
  main.appendChild(
    element('h3', { text: t('security.twoFactor.heading', 'Two-factor authentication') }),
  );
  main.appendChild(
    element('p', {
      text: t(
        'security.twoFactor.body',
        'Add an authenticator app or passkey to protect sign-ins.',
      ),
    }),
  );
  main.appendChild(element('h3', { text: t('security.recovery.heading', 'Recovery codes') }));
  main.appendChild(
    element('p', {
      text: t(
        'security.recovery.body',
        'Generate one-time codes to sign in if you lose your device.',
      ),
    }),
  );
}

function pageSessions(main, t, ctx) {
  heading(main, t, 'routes.sessions.title', 'Signed-in sessions', 'sessions.lede');
  const s = sessions(ctx.api);
  const wrap = element('div', { className: 'qtiauth-sessions' });
  main.appendChild(wrap);
  const load = () => {
    clear(wrap);
    void s
      .list()
      .then((data) => {
        const items = data?.items ?? [];
        if (items.length === 0) {
          wrap.appendChild(empty(t, 'sessions.empty', 'No other sessions.'));
          return;
        }
        wrap.appendChild(
          list(items, (session) => {
            const item = element('li', { className: 'qtiauth-session' });
            item.append(
              element('span', {
                className: 'qtiauth-session-label',
                text: `${session.user_agent ?? 'unknown'} — ${session.ip ?? ''}`,
              }),
              element('button', {
                type: 'button',
                text: t('sessions.revoke', 'Revoke'),
                onclick: () => {
                  void s.revoke(session.id).then(load);
                },
              }),
            );
            return item;
          }),
        );
      })
      .catch(() => {
        wrap.appendChild(empty(t, 'sessions.load.error', 'Could not load sessions.'));
      });
  };
  load();
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-ghost',
      text: t('sessions.revokeOthers', 'Sign out other sessions'),
      onclick: () => {
        void s.revokeOthers().then(load);
      },
    }),
  );
}

function pageMethods(main, t, ctx) {
  heading(main, t, 'routes.methods.title', 'Connected sign-in methods', 'methods.lede');
  const methods = ctx.features.auth.methods;
  const rows = [
    { key: 'password', enabled: methods.password },
    { key: 'magic_link', enabled: methods.magic_link },
    { key: 'passkeys', enabled: methods.passkeys },
    { key: 'totp', enabled: methods.totp },
  ];
  main.appendChild(
    list(rows, (row) => {
      const item = element('li');
      const label = t(`methods.${row.key}`, row.key);
      const state = row.enabled ? t('methods.on', 'on') : t('methods.off', 'off');
      item.textContent = `${label} — ${state}`;
      return item;
    }),
  );
}

function pageNotifications(main, t, ctx) {
  heading(main, t, 'routes.notifications.title', 'Notification preferences', 'notifications.lede');
  const account = me(ctx.api);
  const wrap = element('form', { className: 'qtiauth-prefs' });
  main.appendChild(wrap);
  void account.notifications().then((data) => {
    clear(wrap);
    const preferences = data?.preferences ?? {};
    const channels = Object.entries(preferences);
    if (channels.length === 0) {
      wrap.appendChild(empty(t, 'notifications.empty', 'No preferences yet.'));
      return;
    }
    for (const [channel, value] of channels) {
      const id = `qtiauth-p-${channel}`;
      const box = element('p', { className: 'qtiauth-field' });
      box.append(
        element('input', { id, name: channel, type: 'checkbox', checked: Boolean(value) }),
        element('label', { htmlFor: id, text: t(`notifications.channel.${channel}`, channel) }),
      );
      wrap.appendChild(box);
    }
    const feedback = element('div', { className: 'qtiauth-feedback' });
    wrap.appendChild(submitRow(t, 'notifications.submit'));
    wrap.appendChild(feedback);
    wrap.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = {};
      for (const input of wrap.querySelectorAll('input[type=checkbox]')) {
        values[input.name] = input.checked;
      }
      void runForm(wrap, feedback, t, async () => {
        await account.setNotifications(values);
        feedback.appendChild(successRow(t, 'notifications.success'));
      });
    });
  });
}

function pageLegal(main, t, ctx) {
  heading(main, t, 'routes.legal.title', 'Legal acceptance', 'legal.lede');
  const account = me(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void account.legal().then((data) => {
    const documents = data?.documents ?? [];
    if (documents.length === 0) {
      wrap.appendChild(empty(t, 'legal.empty', 'No documents require acceptance.'));
      return;
    }
    wrap.appendChild(
      list(documents, (document) => {
        const item = element('li', { className: 'qtiauth-legal-item' });
        item.append(
          element('a', {
            href: document.url,
            text: document.title,
            attrs: { target: '_blank', rel: 'noopener' },
          }),
          element('button', {
            type: 'button',
            text: t('legal.accept', 'Accept'),
            onclick: () => {
              void account
                .acceptLegal(document.id, document.version)
                .then(() => item.appendChild(successRow(t, 'legal.accepted')));
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageData(main, t, ctx) {
  heading(main, t, 'routes.data.title', 'Data export and deletion', 'data.lede');
  const account = me(ctx.api);
  main.appendChild(element('h3', { text: t('data.export.heading', 'Export your data') }));
  const exportStatus = element('div', {
    className: 'qtiauth-status',
    attrs: { 'aria-live': 'polite' },
  });
  main.appendChild(exportStatus);
  main.appendChild(
    element('button', {
      type: 'button',
      text: t('data.export.submit', 'Request export'),
      onclick: () => {
        clear(exportStatus);
        void account
          .export()
          .then((result) => {
            exportStatus.appendChild(
              element('p', {
                text: t('data.export.queued', `Export queued: ${result?.id ?? ''}`),
              }),
            );
          })
          .catch(() => {
            exportStatus.appendChild(problemAlert(t, { code: 'INTERNAL_ERROR' }));
          });
      },
    }),
  );
  main.appendChild(element('h3', { text: t('data.deletion.heading', 'Delete your account') }));
  const deletionStatus = element('div', {
    className: 'qtiauth-status',
    attrs: { 'aria-live': 'polite' },
  });
  main.appendChild(deletionStatus);
  main.appendChild(
    element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-danger',
      text: t('data.deletion.submit', 'Request deletion'),
      onclick: () => {
        clear(deletionStatus);
        void account.requestDeletion().then((result) => {
          deletionStatus.appendChild(
            element('p', {
              text: t('data.deletion.queued', `Scheduled for ${result?.scheduled_at ?? 'soon'}`),
            }),
          );
        });
      },
    }),
  );
}

function pageFamily(main, t, ctx) {
  heading(main, t, 'routes.family.title', 'Family dashboard', 'family.lede');
  const f = family(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void f.list().then((data) => {
    const children = data?.children ?? [];
    if (children.length === 0) {
      wrap.appendChild(empty(t, 'family.empty', 'No linked children.'));
      return;
    }
    wrap.appendChild(
      list(children, (child) => {
        const item = element('li');
        item.appendChild(
          element('a', {
            href: ctx.href(`/family/${encodeURIComponent(child.id)}`),
            text: child.display_name ?? child.username ?? child.id,
            onclick: (event) => {
              event.preventDefault();
              ctx.navigate(`/family/${encodeURIComponent(child.id)}`);
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageChild(main, t, ctx, params) {
  heading(main, t, 'routes.family.child.title', 'Child dashboard', 'family.child.lede');
  const f = family(ctx.api);
  const details = element('dl', { className: 'qtiauth-details' });
  main.appendChild(details);
  void f.child(params.id).then((data) => {
    const rows = [
      ['family.field.username', data?.username ?? ''],
      ['family.field.age_band', data?.age_band ?? ''],
      ['family.field.status', data?.status ?? ''],
    ];
    for (const [key, value] of rows) {
      details.append(element('dt', { text: t(key, key) }), element('dd', { text: value }));
    }
  });
}

function pageChildWaiting(main, t) {
  heading(main, t, 'routes.waiting.title', 'Waiting for a guardian');
  main.appendChild(
    element('p', {
      text: t(
        'waiting.body',
        'Ask a parent or guardian to approve your account. This page will refresh when they do.',
      ),
    }),
  );
}

function pageConsent(main, t, ctx) {
  heading(main, t, 'routes.consent.title', 'Authorize app', 'consent.lede');
  const query = new URLSearchParams(ctx.location.search);
  const clientId = query.get('client_id') ?? '';
  const scope = query.get('scope') ?? '';
  main.appendChild(
    element('dl', { className: 'qtiauth-details' }, [
      element('dt', { text: t('consent.field.app', 'App') }),
      element('dd', { text: clientId }),
      element('dt', { text: t('consent.field.scope', 'Requested access') }),
      element('dd', { text: scope }),
    ]),
  );
  main.appendChild(
    element('form', { method: 'post', action: `${ctx.apiBase}/api/v1/oauth/authorize` }, [
      element('input', { type: 'hidden', name: 'client_id', value: clientId }),
      element('input', { type: 'hidden', name: 'scope', value: scope }),
      element('button', {
        type: 'submit',
        name: 'decision',
        value: 'allow',
        text: t('consent.allow', 'Allow'),
      }),
      element('button', {
        type: 'submit',
        className: 'qtiauth-button qtiauth-button-ghost',
        name: 'decision',
        value: 'deny',
        text: t('consent.deny', 'Deny'),
      }),
    ]),
  );
}

function pageDevice(main, t, ctx) {
  heading(main, t, 'routes.device.title', 'Enter device code', 'device.lede');
  const o = oauth(ctx.api);
  main.appendChild(
    form(
      [{ name: 'user_code', label: 'field.userCode', autocomplete: 'one-time-code' }],
      t,
      'device.submit',
      async (values, { feedback }) => {
        await o.devicePair(values.user_code);
        feedback.appendChild(successRow(t, 'device.success'));
      },
    ),
  );
}

function pageApps(main, t, ctx) {
  heading(main, t, 'routes.apps.title', 'Authorised apps', 'routes.apps.body');
  const o = oauth(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void o.authorizedApps().then((data) => {
    const apps = data?.items ?? [];
    if (apps.length === 0) {
      wrap.appendChild(empty(t, 'apps.empty', 'No apps are connected.'));
      return;
    }
    wrap.appendChild(
      list(apps, (app) => {
        const item = element('li');
        item.append(
          element('span', { text: app.client_name ?? app.client_id }),
          element('button', {
            type: 'button',
            text: t('apps.revoke', 'Revoke'),
            onclick: () => {
              void o.revokeApp(app.client_id).then(() => item.remove());
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageDeveloper(main, t, ctx) {
  heading(main, t, 'routes.developer.title', 'Developer portal', 'developer.lede');
  const o = oauth(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void o.developerClients().then((data) => {
    const clients = data?.items ?? [];
    if (clients.length === 0) {
      wrap.appendChild(empty(t, 'developer.empty', 'No OAuth clients yet.'));
    } else {
      wrap.appendChild(
        list(clients, (item) => {
          const row = element('li');
          row.append(
            element('span', { text: item.name ?? item.client_id }),
            element('span', { className: 'qtiauth-muted', text: item.client_id }),
          );
          return row;
        }),
      );
    }
    main.appendChild(
      element('h3', { text: t('developer.create.heading', 'Register a new client') }),
    );
    main.appendChild(
      form(
        [
          { name: 'name', label: 'field.clientName' },
          { name: 'redirect_uris', label: 'field.redirectUris' },
        ],
        t,
        'developer.create.submit',
        async (values, { feedback }) => {
          await o.createClient({
            name: values.name,
            redirect_uris: values.redirect_uris.split(/\s+/u).filter(Boolean),
          });
          feedback.appendChild(successRow(t, 'developer.create.success'));
        },
      ),
    );
  });
}

function pageGames(main, t, ctx) {
  heading(main, t, 'routes.games.title', 'Games', 'routes.games.body');
  const g = games(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void g.library().then((data) => {
    const owned = data?.items ?? [];
    if (owned.length === 0) {
      wrap.appendChild(empty(t, 'games.empty', 'No games in your library yet.'));
      return;
    }
    wrap.appendChild(
      list(owned, (entry) => {
        const item = element('li');
        item.textContent = entry.title ?? entry.game_id;
        return item;
      }),
    );
  });
  const sub = [
    ['/games/redeem', 'games.section.redeem'],
    ['/games/achievements', 'games.section.achievements'],
    ['/games/stats', 'games.section.stats'],
    ['/games/leaderboards', 'games.section.leaderboards'],
    ['/games/devices', 'games.section.devices'],
  ];
  main.appendChild(
    list(sub, ([path, label]) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(path),
          text: t(label, path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(path);
          },
        }),
      );
      return item;
    }),
  );
}

function pageRedeem(main, t, ctx) {
  heading(main, t, 'routes.redeem.title', 'Redeem a key', 'redeem.lede');
  const g = games(ctx.api);
  main.appendChild(
    form(
      [{ name: 'code', label: 'field.key', autocomplete: 'off' }],
      t,
      'redeem.submit',
      async (values, { feedback }) => {
        const result = await g.redeem(values.code);
        feedback.appendChild(
          element('p', {
            className: 'qtiauth-success',
            attrs: { role: 'status' },
            text: t('redeem.success', `Added ${result?.title ?? 'game'} to your library.`),
          }),
        );
      },
    ),
  );
}

function pageDevices(main, t, ctx) {
  heading(main, t, 'routes.devices.title', 'Game devices', 'devices.lede');
  const g = games(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void g.devices().then((data) => {
    const devices = data?.items ?? [];
    if (devices.length === 0) {
      wrap.appendChild(empty(t, 'devices.empty', 'No linked devices.'));
      return;
    }
    wrap.appendChild(
      list(devices, (device) => {
        const item = element('li');
        item.append(
          element('span', { text: `${device.name ?? device.id} — ${device.platform ?? ''}` }),
          element('button', {
            type: 'button',
            text: t('devices.revoke', 'Revoke'),
            onclick: () => {
              void g.revokeDevice(device.id).then(() => item.remove());
            },
          }),
        );
        return item;
      }),
    );
  });
}

function gamePickerPage(main, t, ctx, action, titleKey, fallback) {
  heading(main, t, titleKey, fallback);
  const g = games(ctx.api);
  const output = element('div', { className: 'qtiauth-status' });
  main.appendChild(
    form([{ name: 'game_id', label: 'field.game' }], t, 'games.load', async (values) => {
      clear(output);
      const data = await action(g, values.game_id);
      const items = data?.items ?? [];
      if (items.length === 0) {
        output.appendChild(empty(t, 'games.section.empty', 'Nothing to show.'));
        return;
      }
      output.appendChild(
        list(items, (row) => {
          const item = element('li');
          item.textContent = row.title ?? row.name ?? JSON.stringify(row);
          return item;
        }),
      );
    }),
  );
  main.appendChild(output);
}

function pageAchievements(main, t, ctx) {
  gamePickerPage(
    main,
    t,
    ctx,
    (g, id) => g.achievements(id),
    'routes.achievements.title',
    'Achievements',
  );
}

function pageStats(main, t, ctx) {
  gamePickerPage(main, t, ctx, (g, id) => g.stats(id), 'routes.stats.title', 'Stats');
}

function pageLeaderboards(main, t, ctx) {
  gamePickerPage(
    main,
    t,
    ctx,
    (g, id) => g.leaderboards(id),
    'routes.leaderboards.title',
    'Leaderboards',
  );
}

function pageReport(main, t, ctx) {
  heading(main, t, 'routes.report.title', 'Report user or content', 'report.lede');
  const r = reports(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'target', label: 'field.target' },
        { name: 'reason', label: 'field.reason' },
        { name: 'detail', label: 'field.detail', required: false },
      ],
      t,
      'report.submit',
      async (values, { feedback }) => {
        await r.submit({ target: values.target, reason: values.reason, detail: values.detail });
        feedback.appendChild(successRow(t, 'report.success'));
      },
    ),
  );
}

function pageSupportHome(main, t, ctx) {
  heading(main, t, 'routes.support.title', 'Support', 'support.lede');
  const sections = [
    ['/support/kb', 'support.section.kb'],
    ['/support/kb/search', 'support.section.search'],
    ['/support/tickets', 'support.section.tickets'],
    ['/support/tickets/new', 'support.section.newTicket'],
    ['/support/appeals/new', 'support.section.appeal'],
    ['/support/guest/start', 'support.section.guest'],
  ];
  main.appendChild(
    list(sections, ([path, label]) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(path),
          text: t(label, path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(path);
          },
        }),
      );
      return item;
    }),
  );
}

function pageKbHome(main, t, ctx) {
  heading(main, t, 'routes.kb.title', 'Help centre', 'kb.lede');
  const k = kb(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void k.categories().then((data) => {
    const items = data?.items ?? [];
    if (items.length === 0) {
      wrap.appendChild(empty(t, 'kb.empty', 'No articles have been published yet.'));
      return;
    }
    wrap.appendChild(
      list(items, (category) => {
        const item = element('li');
        item.appendChild(
          element('a', {
            href: ctx.href(`/support/kb/categories/${encodeURIComponent(category.slug)}`),
            text: category.name,
            onclick: (event) => {
              event.preventDefault();
              ctx.navigate(`/support/kb/categories/${encodeURIComponent(category.slug)}`);
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageKbCategory(main, t, ctx, params) {
  heading(main, t, 'routes.kb.category.title', 'Category');
  const k = kb(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void k.category(params.slug).then((data) => {
    const name = data?.name ?? params.slug;
    main.querySelector('h2').textContent = name;
    const articles = data?.articles?.items ?? [];
    if (articles.length === 0) {
      wrap.appendChild(empty(t, 'kb.category.empty', 'No articles in this category.'));
      return;
    }
    wrap.appendChild(
      list(articles, (article) => {
        const item = element('li');
        item.appendChild(
          element('a', {
            href: ctx.href(`/support/kb/articles/${encodeURIComponent(article.slug)}`),
            text: article.title,
            onclick: (event) => {
              event.preventDefault();
              ctx.navigate(`/support/kb/articles/${encodeURIComponent(article.slug)}`);
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageKbSearch(main, t, ctx) {
  heading(main, t, 'routes.kb.search.title', 'Search the help centre', 'kb.search.lede');
  const k = kb(ctx.api);
  const results = element('div');
  main.appendChild(
    form(
      [{ name: 'q', label: 'field.query', autocomplete: 'off' }],
      t,
      'kb.search.submit',
      async (values) => {
        clear(results);
        const data = await k.search(values.q);
        const items = data?.items ?? [];
        if (items.length === 0) {
          results.appendChild(empty(t, 'kb.search.empty', 'No matching articles.'));
          return;
        }
        results.appendChild(
          list(items, (article) => {
            const item = element('li');
            item.appendChild(
              element('a', {
                href: ctx.href(`/support/kb/articles/${encodeURIComponent(article.slug)}`),
                text: article.title,
                onclick: (event) => {
                  event.preventDefault();
                  ctx.navigate(`/support/kb/articles/${encodeURIComponent(article.slug)}`);
                },
              }),
            );
            return item;
          }),
        );
      },
    ),
  );
  main.appendChild(results);
}

function pageKbArticle(main, t, ctx, params) {
  heading(main, t, 'routes.kb.article.title', 'Article');
  const k = kb(ctx.api);
  const body = element('div', { className: 'qtiauth-article' });
  const meta = element('p', { className: 'qtiauth-muted' });
  const feedback = element('div', { className: 'qtiauth-status' });
  main.append(meta, body, feedback);
  void k.article(params.slug).then((data) => {
    if (data === null) {
      body.appendChild(empty(t, 'kb.article.missing', 'That article is not available.'));
      return;
    }
    main.querySelector('h2').textContent = data.title;
    meta.textContent = `${data.category?.name ?? ''} — ${data.updated_at}`;
    body.innerHTML = data.html;
    const yes = element('button', {
      type: 'button',
      text: t('kb.feedback.yes', 'Yes, this helped'),
      onclick: () => {
        void k.feedback(params.slug, true).then(() => {
          clear(feedback);
          feedback.appendChild(successRow(t, 'kb.feedback.thanks'));
        });
      },
    });
    const no = element('button', {
      type: 'button',
      className: 'qtiauth-button qtiauth-button-ghost',
      text: t('kb.feedback.no', 'No, this did not help'),
      onclick: () => {
        void k.feedback(params.slug, false).then(() => {
          clear(feedback);
          feedback.appendChild(successRow(t, 'kb.feedback.thanks'));
        });
      },
    });
    const buttons = element('p', { className: 'qtiauth-actions' });
    buttons.append(yes, no);
    main.appendChild(buttons);
  });
}

function pageMyTickets(main, t, ctx) {
  heading(main, t, 'routes.tickets.title', 'Your tickets', 'tickets.lede');
  const s = support(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void s.listTickets().then((data) => {
    const items = data?.items ?? [];
    if (items.length === 0) {
      wrap.appendChild(empty(t, 'tickets.empty', 'You have not opened any tickets.'));
      return;
    }
    wrap.appendChild(
      list(items, (ticket) => {
        const item = element('li');
        item.appendChild(
          element('a', {
            href: ctx.href(`/support/tickets/${encodeURIComponent(ticket.id)}`),
            text: `#${ticket.number} — ${ticket.subject} (${ticket.status})`,
            onclick: (event) => {
              event.preventDefault();
              ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageNewTicket(main, t, ctx) {
  heading(main, t, 'routes.tickets.new.title', 'Open a support ticket', 'tickets.new.lede');
  const s = support(ctx.api);
  const categories = element('select', { name: 'category_id', required: true });
  categories.appendChild(
    element('option', { value: '', text: t('tickets.new.pickCategory', 'Choose a category') }),
  );
  void s.categories().then((data) => {
    const items = data?.items ?? [];
    for (const category of items) {
      categories.appendChild(element('option', { value: category.id, text: category.name }));
    }
  });
  const feedback = element('div', {
    className: 'qtiauth-feedback',
    attrs: { 'aria-live': 'polite' },
  });
  const el = element('form', { noValidate: true });
  const categoryWrap = element('p', { className: 'qtiauth-field' });
  categoryWrap.append(
    element('label', { htmlFor: 'qtiauth-f-category', text: t('field.category', 'Category') }),
    categories,
  );
  categories.id = 'qtiauth-f-category';
  el.appendChild(categoryWrap);
  const subject = element('input', { type: 'text', name: 'subject', required: true });
  subject.id = 'qtiauth-f-subject';
  const subjectWrap = element('p', { className: 'qtiauth-field' });
  subjectWrap.append(
    element('label', { htmlFor: 'qtiauth-f-subject', text: t('field.subject', 'Subject') }),
    subject,
  );
  el.appendChild(subjectWrap);
  const body = element('textarea', { name: 'body', required: true, rows: 6 });
  body.id = 'qtiauth-f-body';
  const bodyWrap = element('p', { className: 'qtiauth-field' });
  bodyWrap.append(
    element('label', { htmlFor: 'qtiauth-f-body', text: t('field.message', 'Message') }),
    body,
  );
  el.appendChild(bodyWrap);
  el.appendChild(submitRow(t, 'tickets.new.submit'));
  el.appendChild(feedback);
  el.addEventListener('submit', (event) => {
    event.preventDefault();
    void runForm(el, feedback, t, async () => {
      const ticket = await s.createTicket({
        category_id: categories.value,
        subject: subject.value,
        body: body.value,
      });
      ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
    });
  });
  main.appendChild(el);
}

function renderTicketDetail(main, t, ctx, ticket, api) {
  main.querySelector('h2').textContent = `#${ticket.number} — ${ticket.subject}`;
  const meta = element('p', { className: 'qtiauth-muted' });
  meta.textContent = `${ticket.status} — ${ticket.priority} — ${ticket.created_at}`;
  main.appendChild(meta);
  const thread = element('ol', { className: 'qtiauth-thread' });
  for (const message of ticket.messages ?? []) {
    const item = element('li', {
      className: message.staff ? 'qtiauth-message qtiauth-message-staff' : 'qtiauth-message',
    });
    item.append(
      element('p', {
        className: 'qtiauth-muted',
        text: `${message.staff ? t('tickets.staff', 'Staff') : t('tickets.you', 'You')} — ${message.created_at}`,
      }),
      element('p', { text: message.body }),
    );
    thread.appendChild(item);
  }
  main.appendChild(thread);
  const attachments = ticket.attachments ?? [];
  if (attachments.length > 0) {
    main.appendChild(element('h3', { text: t('tickets.attachments', 'Attachments') }));
    main.appendChild(
      list(attachments, (attachment) => {
        const item = element('li');
        item.append(
          element('span', { text: `${attachment.filename} (${attachment.content_type})` }),
          element('button', {
            type: 'button',
            text: t('tickets.download', 'Download'),
            onclick: () => {
              void api.downloadAttachment(ticket.id, attachment.id).then((result) => {
                if (result?.url) window.open(result.url, '_blank', 'noopener');
              });
            },
          }),
        );
        return item;
      }),
    );
  }
  if (ticket.status !== 'closed') {
    main.appendChild(element('h3', { text: t('tickets.reply.heading', 'Reply') }));
    main.appendChild(
      form(
        [{ name: 'body', label: 'field.message' }],
        t,
        'tickets.reply.submit',
        async (values, { feedback }) => {
          await api.reply(ticket.id, values.body);
          feedback.appendChild(successRow(t, 'tickets.reply.success'));
          ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
        },
      ),
    );
    main.appendChild(
      element('button', {
        type: 'button',
        className: 'qtiauth-button qtiauth-button-ghost',
        text: t('tickets.close', 'Close ticket'),
        onclick: () => {
          void api.close(ticket.id).then(() => ctx.navigate('/support/tickets'));
        },
      }),
    );
  } else {
    main.appendChild(
      element('button', {
        type: 'button',
        text: t('tickets.reopen', 'Reopen ticket'),
        onclick: () => {
          void api.reopen(ticket.id).then(() => {
            ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
          });
        },
      }),
    );
    if (ticket.rating === null) {
      main.appendChild(element('h3', { text: t('tickets.rate.heading', 'Rate this ticket') }));
      const rating = element('div', { className: 'qtiauth-actions' });
      for (const score of [1, 2, 3, 4, 5]) {
        rating.appendChild(
          element('button', {
            type: 'button',
            text: String(score),
            onclick: () => {
              void api.rate(ticket.id, score).then(() => {
                ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
              });
            },
          }),
        );
      }
      main.appendChild(rating);
    }
  }
}

function pageTicket(main, t, ctx, params) {
  heading(main, t, 'routes.tickets.detail.title', 'Ticket');
  const s = support(ctx.api);
  void s.getTicket(params.id).then((ticket) => renderTicketDetail(main, t, ctx, ticket, s));
}

function pageAppeal(main, t, ctx) {
  heading(main, t, 'routes.appeals.title', 'Appeal a decision', 'appeals.lede');
  const s = support(ctx.api);
  main.appendChild(
    form(
      [
        { name: 'action_id', label: 'field.actionId', required: false },
        { name: 'body', label: 'field.message' },
      ],
      t,
      'appeals.submit',
      async (values, { feedback }) => {
        const ticket = await s.createAppeal({
          action_id: values.action_id === '' ? undefined : values.action_id,
          body: values.body,
        });
        feedback.appendChild(successRow(t, 'appeals.success'));
        ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
      },
    ),
  );
}

function pageGuestStart(main, t, ctx) {
  heading(main, t, 'routes.guest.title', 'Contact support without signing in', 'guest.lede');
  const g = guestSupport(ctx.api);
  main.appendChild(
    form(
      [{ name: 'email', type: 'email', label: 'field.email', autocomplete: 'email' }],
      t,
      'guest.code.submit',
      async (values, { feedback }) => {
        await g.requestCode(values.email, undefined);
        feedback.appendChild(successRow(t, 'guest.code.sent'));
        ctx.navigate(`/support/guest/verify?email=${encodeURIComponent(values.email)}`);
      },
    ),
  );
}

function pageGuestVerify(main, t, ctx) {
  heading(main, t, 'routes.guest.verify.title', 'Open a guest ticket', 'guest.verify.lede');
  const g = guestSupport(ctx.api);
  const query = new URLSearchParams(ctx.location.search);
  const emailFromQuery = query.get('email') ?? '';
  const categories = element('select', { name: 'category_id', required: true });
  categories.id = 'qtiauth-f-category';
  categories.appendChild(
    element('option', { value: '', text: t('tickets.new.pickCategory', 'Choose a category') }),
  );
  void g.categories().then((data) => {
    for (const category of data?.items ?? []) {
      categories.appendChild(element('option', { value: category.id, text: category.name }));
    }
  });
  const feedback = element('div', {
    className: 'qtiauth-feedback',
    attrs: { 'aria-live': 'polite' },
  });
  const el = element('form', { noValidate: true });
  const inputs = new Map();
  for (const spec of [
    { name: 'email', type: 'email', label: 'field.email', value: emailFromQuery },
    { name: 'code', label: 'field.code' },
    { name: 'subject', label: 'field.subject' },
    { name: 'body', label: 'field.message' },
  ]) {
    const { wrap, input } = field(t, spec);
    el.appendChild(wrap);
    inputs.set(spec.name, input);
  }
  const categoryWrap = element('p', { className: 'qtiauth-field' });
  categoryWrap.append(
    element('label', { htmlFor: 'qtiauth-f-category', text: t('field.category', 'Category') }),
    categories,
  );
  el.insertBefore(categoryWrap, el.children[2] ?? null);
  el.appendChild(submitRow(t, 'guest.verify.submit'));
  el.appendChild(feedback);
  el.addEventListener('submit', (event) => {
    event.preventDefault();
    void runForm(el, feedback, t, async () => {
      const result = await g.createTicket({
        email: inputs.get('email').value,
        code: inputs.get('code').value,
        category_id: categories.value,
        subject: inputs.get('subject').value,
        body: inputs.get('body').value,
      });
      feedback.appendChild(
        element('p', {
          className: 'qtiauth-success',
          attrs: { role: 'status' },
          text: t('guest.verify.success', `Ticket #${result?.number ?? ''} opened.`),
        }),
      );
    });
  });
  main.appendChild(el);
}

function pageGuestView(main, t, ctx) {
  heading(main, t, 'routes.guest.view.title', 'Follow a guest ticket', 'guest.view.lede');
  const g = guestSupport(ctx.api);
  const detail = element('div');
  main.appendChild(
    form([{ name: 'token', label: 'field.token' }], t, 'guest.view.submit', async (values) => {
      clear(detail);
      const ticket = await g.viewTicket(values.token);
      renderTicketDetail(detail, t, ctx, ticket, {
        reply: (id, body) => g.reply(values.token, body),
        close: () => g.close(values.token),
        reopen: () => g.reopen(values.token),
        rate: (id, rating) => g.rate(values.token, rating),
        downloadAttachment: (_id, attachmentId) => g.downloadAttachment(values.token, attachmentId),
      });
    }),
  );
  detail.appendChild(element('h3', { text: t('guest.view.ticket', 'Ticket') }));
  main.appendChild(detail);
}

function pageStaffSupport(main, t, ctx) {
  heading(main, t, 'routes.support.staff.title', 'Support staff', 'support.staff.lede');
  const sections = [
    ['/support/staff/tickets', 'support.staff.section.queue'],
    ['/support/staff/macros', 'support.staff.section.macros'],
    ['/support/staff/metrics', 'support.staff.section.metrics'],
    ['/support/staff/kb', 'support.staff.section.kb'],
  ];
  main.appendChild(
    list(sections, ([path, label]) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(path),
          text: t(label, path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(path);
          },
        }),
      );
      return item;
    }),
  );
}

function pageStaffQueue(main, t, ctx) {
  heading(main, t, 'routes.support.staff.queue.title', 'Support queue');
  const s = staffSupport(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void s.tickets().then((data) => {
    const items = data?.items ?? [];
    if (items.length === 0) {
      wrap.appendChild(empty(t, 'support.staff.queue.empty', 'No tickets in the queue.'));
      return;
    }
    wrap.appendChild(
      list(items, (ticket) => {
        const item = element('li');
        item.appendChild(
          element('a', {
            href: ctx.href(`/support/staff/tickets/${encodeURIComponent(ticket.id)}`),
            text: `#${ticket.number} — ${ticket.subject} (${ticket.status}, ${ticket.priority})`,
            onclick: (event) => {
              event.preventDefault();
              ctx.navigate(`/support/staff/tickets/${encodeURIComponent(ticket.id)}`);
            },
          }),
        );
        return item;
      }),
    );
  });
}

function pageStaffTicket(main, t, ctx, params) {
  heading(main, t, 'routes.support.staff.ticket.title', 'Ticket');
  const s = staffSupport(ctx.api);
  const detail = element('div');
  main.appendChild(detail);
  void s.ticket(params.id).then((ticket) => {
    clear(detail);
    detail.appendChild(element('h3', { text: `#${ticket.number} — ${ticket.subject}` }));
    detail.appendChild(
      element('p', {
        className: 'qtiauth-muted',
        text: `${ticket.status} — ${ticket.priority} — ${ticket.created_at}`,
      }),
    );
    const thread = element('ol', { className: 'qtiauth-thread' });
    for (const message of ticket.messages ?? []) {
      const item = element('li', {
        className: message.staff ? 'qtiauth-message qtiauth-message-staff' : 'qtiauth-message',
      });
      item.append(
        element('p', {
          className: 'qtiauth-muted',
          text: `${message.staff ? t('tickets.staff', 'Staff') : t('tickets.user', 'User')} — ${message.created_at}`,
        }),
        element('p', { text: message.body }),
      );
      thread.appendChild(item);
    }
    detail.appendChild(thread);
    detail.appendChild(element('h3', { text: t('support.staff.notes.heading', 'Internal notes') }));
    const notes = element('ol', { className: 'qtiauth-thread' });
    for (const note of ticket.notes ?? []) {
      const item = element('li', { className: 'qtiauth-message qtiauth-message-note' });
      item.append(
        element('p', { className: 'qtiauth-muted', text: note.created_at }),
        element('p', { text: note.body }),
      );
      notes.appendChild(item);
    }
    detail.appendChild(notes);
    detail.appendChild(
      form(
        [{ name: 'body', label: 'field.note' }],
        t,
        'support.staff.notes.submit',
        async (values, { feedback }) => {
          await s.addNote(ticket.id, values.body);
          feedback.appendChild(successRow(t, 'support.staff.notes.success'));
          ctx.navigate(`/support/staff/tickets/${encodeURIComponent(ticket.id)}`);
        },
      ),
    );
    detail.appendChild(element('h3', { text: t('support.staff.reply.heading', 'Reply as staff') }));
    detail.appendChild(
      form(
        [{ name: 'body', label: 'field.message' }],
        t,
        'support.staff.reply.submit',
        async (values, { feedback }) => {
          await s.reply(ticket.id, { body: values.body });
          feedback.appendChild(successRow(t, 'support.staff.reply.success'));
          ctx.navigate(`/support/staff/tickets/${encodeURIComponent(ticket.id)}`);
        },
      ),
    );
  });
}

function pageStaffMacros(main, t, ctx) {
  heading(main, t, 'routes.support.staff.macros.title', 'Canned responses');
  const s = staffSupport(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  const load = () => {
    clear(wrap);
    void s.macros().then((data) => {
      const items = data?.items ?? [];
      if (items.length === 0) {
        wrap.appendChild(empty(t, 'support.staff.macros.empty', 'No canned responses yet.'));
      } else {
        wrap.appendChild(
          list(items, (macro) => {
            const item = element('li');
            item.append(
              element('span', { text: macro.name }),
              element('button', {
                type: 'button',
                text: t('support.staff.macros.delete', 'Delete'),
                onclick: () => {
                  void s.deleteMacro(macro.id).then(load);
                },
              }),
            );
            return item;
          }),
        );
      }
    });
  };
  load();
  main.appendChild(element('h3', { text: t('support.staff.macros.new', 'Add a canned response') }));
  main.appendChild(
    form(
      [
        { name: 'name', label: 'field.name' },
        { name: 'body', label: 'field.message' },
      ],
      t,
      'support.staff.macros.submit',
      async (values, { feedback }) => {
        await s.createMacro({ name: values.name, body: values.body });
        feedback.appendChild(successRow(t, 'support.staff.macros.success'));
        load();
      },
    ),
  );
}

function pageStaffMetrics(main, t, ctx) {
  heading(main, t, 'routes.support.staff.metrics.title', 'Support metrics');
  const s = staffSupport(ctx.api);
  const wrap = element('dl', { className: 'qtiauth-details' });
  main.appendChild(wrap);
  void s.metrics().then((data) => {
    if (data === null) {
      wrap.append(
        element('dt', { text: t('support.staff.metrics.empty', 'No metrics available.') }),
        element('dd', { text: '' }),
      );
      return;
    }
    const rows = [
      ['support.staff.metrics.firstResponse', String(data.first_response_seconds?.average ?? 0)],
      ['support.staff.metrics.resolution', String(data.resolution_seconds?.average ?? 0)],
      ['support.staff.metrics.guest', String(data.guest_tickets ?? 0)],
    ];
    for (const [key, value] of rows) {
      wrap.append(element('dt', { text: t(key, key) }), element('dd', { text: value }));
    }
  });
}

function pageStaffKb(main, t, ctx) {
  heading(main, t, 'routes.support.staff.kb.title', 'Knowledge base editor');
  const k = staffKb(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  void k.articles().then((data) => {
    const items = data?.items ?? [];
    if (items.length === 0) {
      wrap.appendChild(empty(t, 'support.staff.kb.empty', 'No articles yet.'));
    } else {
      wrap.appendChild(
        list(items, (article) => {
          const item = element('li');
          item.appendChild(
            element('a', {
              href: ctx.href(`/support/staff/kb/${encodeURIComponent(article.id)}`),
              text: `${article.title} (${article.status})`,
              onclick: (event) => {
                event.preventDefault();
                ctx.navigate(`/support/staff/kb/${encodeURIComponent(article.id)}`);
              },
            }),
          );
          return item;
        }),
      );
    }
  });
  main.appendChild(element('h3', { text: t('support.staff.kb.new', 'Create an article') }));
  main.appendChild(
    form(
      [
        { name: 'category_id', label: 'field.categoryId' },
        { name: 'slug', label: 'field.slug' },
        { name: 'title', label: 'field.title' },
        { name: 'body', label: 'field.body' },
      ],
      t,
      'support.staff.kb.submit',
      async (values, { feedback }) => {
        const article = await k.createArticle({
          category_id: values.category_id,
          slug: values.slug,
          title: values.title,
          body: values.body,
        });
        feedback.appendChild(successRow(t, 'support.staff.kb.success'));
        ctx.navigate(`/support/staff/kb/${encodeURIComponent(article.id)}`);
      },
    ),
  );
}

function pageStaffKbArticle(main, t, ctx, params) {
  heading(main, t, 'routes.support.staff.kb.article.title', 'Article');
  const k = staffKb(ctx.api);
  const revisionsBox = element('div');
  const editor = element('div');
  main.append(
    editor,
    element('h3', { text: t('support.staff.kb.revisions', 'Revisions') }),
    revisionsBox,
  );
  void k.article(params.id).then((article) => {
    if (article === null) {
      editor.appendChild(empty(t, 'support.staff.kb.missing', 'That article is not available.'));
      return;
    }
    main.querySelector('h2').textContent = article.title;
    editor.appendChild(
      form(
        [
          { name: 'title', label: 'field.title', value: article.title },
          { name: 'slug', label: 'field.slug', value: article.slug },
          { name: 'body', label: 'field.body', value: article.body },
        ],
        t,
        'support.staff.kb.article.submit',
        async (values, { feedback }) => {
          await k.updateArticle(article.id, {
            title: values.title,
            slug: values.slug,
            body: values.body,
          });
          feedback.appendChild(successRow(t, 'support.staff.kb.article.success'));
        },
      ),
    );
  });
  void k.revisions(params.id).then((data) => {
    const items = data?.items ?? [];
    if (items.length === 0) {
      revisionsBox.appendChild(empty(t, 'support.staff.kb.revisions.empty', 'No revisions yet.'));
      return;
    }
    revisionsBox.appendChild(
      list(items, (revision) => {
        const item = element('li');
        item.append(
          element('span', {
            text: `r${revision.revision} — ${revision.title} — ${revision.created_at}`,
          }),
          element('button', {
            type: 'button',
            text: t('support.staff.kb.revisions.restore', 'Restore'),
            onclick: () => {
              void k.restore(params.id, revision.revision).then(() => {
                ctx.navigate(`/support/staff/kb/${encodeURIComponent(params.id)}`);
              });
            },
          }),
        );
        return item;
      }),
    );
  });
}

function adminIndex(main, t, ctx) {
  heading(main, t, 'routes.admin.title', 'Administration', 'admin.lede');
  const sections = [
    ['/admin/users', 'admin.section.users'],
    ['/admin/roles', 'admin.section.roles'],
    ['/admin/audit', 'admin.section.audit'],
    ['/admin/webhooks', 'admin.section.webhooks'],
    ['/admin/filter', 'admin.section.filter'],
    ['/admin/moderation', 'admin.section.moderation'],
    ['/admin/csea', 'admin.section.csea'],
    ['/admin/oauth', 'admin.section.oauth'],
    ['/admin/games', 'admin.section.games'],
    ['/admin/health', 'admin.section.health'],
  ];
  main.appendChild(
    list(sections, ([path, label]) => {
      const item = element('li');
      item.appendChild(
        element('a', {
          href: ctx.href(path),
          text: t(label, path),
          onclick: (event) => {
            event.preventDefault();
            ctx.navigate(path);
          },
        }),
      );
      return item;
    }),
  );
}

function adminList(main, t, ctx, loader, titleKey, fallback, render) {
  heading(main, t, titleKey, fallback);
  const wrap = element('div');
  main.appendChild(wrap);
  void loader(admin(ctx.api))
    .then((data) => {
      const items = data?.items ?? data ?? [];
      const rows = Array.isArray(items) ? items : [];
      if (rows.length === 0) {
        wrap.appendChild(empty(t, 'admin.empty', 'Nothing to show.'));
        return;
      }
      wrap.appendChild(list(rows, render));
    })
    .catch(() => {
      wrap.appendChild(empty(t, 'admin.load.error', 'Could not load data.'));
    });
}

function pageAdminUsers(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.users(),
    'routes.admin.users.title',
    'Users',
    (user) => {
      const item = element('li');
      item.textContent = `${user.username ?? user.id} — ${user.email ?? ''}`;
      return item;
    },
  );
}

function pageAdminRoles(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.roles(),
    'routes.admin.roles.title',
    'Roles',
    (role) => {
      const item = element('li');
      item.textContent = `${role.name ?? role.id}`;
      return item;
    },
  );
}

function pageAdminAudit(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.audit(),
    'routes.admin.audit.title',
    'Audit',
    (entry) => {
      const item = element('li');
      item.textContent = `${entry.at ?? ''} — ${entry.action ?? ''} — ${entry.actor ?? ''}`;
      return item;
    },
  );
}

function pageAdminWebhooks(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.webhooks(),
    'routes.admin.webhooks.title',
    'Webhooks',
    (hook) => {
      const item = element('li');
      item.textContent = `${hook.url ?? hook.id} — ${(hook.events ?? []).join(', ')}`;
      return item;
    },
  );
}

function pageAdminFilter(main, t, ctx) {
  heading(main, t, 'routes.admin.filter.title', 'Text filter tuning');
  const a = admin(ctx.api);
  const wrap = element('div');
  main.appendChild(wrap);
  const sections = [
    ['admin.filter.blocks', () => a.filterBlocks()],
    ['admin.filter.allowlist', () => a.filterAllowlist()],
    ['admin.filter.blocklist', () => a.filterBlocklist()],
  ];
  for (const [label, loader] of sections) {
    wrap.appendChild(element('h3', { text: t(label, label) }));
    const box = element('div');
    wrap.appendChild(box);
    void loader().then((data) => {
      const rows = data?.items ?? [];
      if (rows.length === 0) {
        box.appendChild(empty(t, 'admin.empty', 'Nothing to show.'));
      } else {
        box.appendChild(
          list(rows, (row) => {
            const item = element('li');
            item.textContent = row.word ?? row.pattern ?? JSON.stringify(row);
            return item;
          }),
        );
      }
    });
  }
}

function pageAdminModeration(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.moderationQueue(),
    'routes.admin.moderation.title',
    'Moderation queue',
    (row) => {
      const item = element('li');
      item.textContent = `${row.kind ?? ''} — ${row.target ?? ''}`;
      return item;
    },
  );
}

function pageAdminCsea(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.cseaCases(),
    'routes.admin.csea.title',
    'CSEA cases',
    (row) => {
      const item = element('li');
      item.textContent = `${row.opened_at ?? ''} — ${row.status ?? ''}`;
      return item;
    },
  );
}

function pageAdminOauth(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.oauthClients(),
    'routes.admin.oauth.title',
    'OAuth client verification',
    (row) => {
      const item = element('li');
      item.textContent = `${row.name ?? row.client_id} — ${row.status ?? ''}`;
      return item;
    },
  );
}

function pageAdminGames(main, t, ctx) {
  adminList(
    main,
    t,
    ctx,
    (a) => a.gamesCatalog(),
    'routes.admin.games.title',
    'Games catalog',
    (row) => {
      const item = element('li');
      item.textContent = `${row.title ?? row.id}`;
      return item;
    },
  );
}

function pageAdminHealth(main, t, ctx) {
  heading(main, t, 'routes.admin.health.title', 'Service health');
  const wrap = element('dl', { className: 'qtiauth-details' });
  main.appendChild(wrap);
  void admin(ctx.api)
    .health()
    .then((data) => {
      const services = data?.services ?? [];
      for (const service of services) {
        wrap.append(element('dt', { text: service.name }), element('dd', { text: service.status }));
      }
    })
    .catch(() => {
      wrap.append(
        element('dt', { text: t('admin.health.title', 'Status') }),
        element('dd', { text: t('admin.load.error', 'Could not load data.') }),
      );
    });
}

export const PAGES = Object.freeze({
  'sign-in': { path: '/sign-in', render: pageSignIn, requires: { auth: true } },
  'sign-up': { path: '/sign-up', render: pageSignUp, requires: { auth: true } },
  verify: { path: '/verify', render: pageVerify },
  forgot: { path: '/forgot', render: pageForgot, requires: { password: true } },
  reset: { path: '/reset', render: pageReset, requires: { password: true } },
  account: { path: '/account', render: pageAccount, requires: { identity: true } },
  profile: { path: '/account/profile', render: pageProfile, requires: { identity: true } },
  email: { path: '/account/email', render: pageEmail, requires: { identity: true } },
  security: { path: '/account/security', render: pageSecurity, requires: { identity: true } },
  sessions: { path: '/account/sessions', render: pageSessions, requires: { identity: true } },
  methods: { path: '/account/methods', render: pageMethods, requires: { identity: true } },
  notifications: {
    path: '/account/notifications',
    render: pageNotifications,
    requires: { identity: true },
  },
  legal: { path: '/account/legal', render: pageLegal, requires: { identity: true } },
  data: { path: '/account/data', render: pageData, requires: { identity: true } },
  family: { path: '/family', render: pageFamily, requires: { identity: true } },
  child: { path: '/family/:id', render: pageChild, requires: { identity: true } },
  'family-session': { path: '/family/session', render: pageFamilySession },
  'family-invite': { path: '/family/invite', render: pageFamilyInvite },
  waiting: { path: '/waiting', render: pageChildWaiting },
  'guardian-approve': { path: '/guardian/approve', render: pageGuardianApprove },
  'guardian-decline': { path: '/guardian/decline', render: pageGuardianDecline },
  'revert-email': { path: '/revert-email', render: pageRevertEmail },
  consent: { path: '/consent', render: pageConsent, requires: { oidc: true } },
  device: { path: '/device', render: pageDevice, requires: { oidc: true } },
  apps: { path: '/apps', render: pageApps, requires: { oidc: true } },
  developer: { path: '/developer', render: pageDeveloper, requires: { oidc: true } },
  games: { path: '/games', render: pageGames, requires: { games: true } },
  redeem: { path: '/games/redeem', render: pageRedeem, requires: { games: true } },
  achievements: {
    path: '/games/achievements',
    render: pageAchievements,
    requires: { games: true },
  },
  stats: { path: '/games/stats', render: pageStats, requires: { games: true } },
  leaderboards: {
    path: '/games/leaderboards',
    render: pageLeaderboards,
    requires: { games: true },
  },
  devices: { path: '/games/devices', render: pageDevices, requires: { games: true } },
  report: { path: '/report', render: pageReport, requires: { safety: true } },
  support: { path: '/support', render: pageSupportHome, requires: { support: true } },
  'support-kb': { path: '/support/kb', render: pageKbHome, requires: { support: true } },
  'support-kb-search': {
    path: '/support/kb/search',
    render: pageKbSearch,
    requires: { support: true },
  },
  'support-kb-category': {
    path: '/support/kb/categories/:slug',
    render: pageKbCategory,
    requires: { support: true },
  },
  'support-kb-article': {
    path: '/support/kb/articles/:slug',
    render: pageKbArticle,
    requires: { support: true },
  },
  'support-tickets': {
    path: '/support/tickets',
    render: pageMyTickets,
    requires: { support: true, identity: true },
  },
  'support-tickets-new': {
    path: '/support/tickets/new',
    render: pageNewTicket,
    requires: { support: true, identity: true },
  },
  'support-ticket': {
    path: '/support/tickets/:id',
    render: pageTicket,
    requires: { support: true, identity: true },
  },
  'support-appeal': {
    path: '/support/appeals/new',
    render: pageAppeal,
    requires: { support: true, identity: true },
  },
  'support-guest': {
    path: '/support/guest/start',
    render: pageGuestStart,
    requires: { support: true },
  },
  'support-guest-verify': {
    path: '/support/guest/verify',
    render: pageGuestVerify,
    requires: { support: true },
  },
  'support-guest-view': {
    path: '/support/guest/view',
    render: pageGuestView,
    requires: { support: true },
  },
  'support-staff': {
    path: '/support/staff',
    render: pageStaffSupport,
    requires: { support: true, admin: true },
  },
  'support-staff-tickets': {
    path: '/support/staff/tickets',
    render: pageStaffQueue,
    requires: { support: true, admin: true },
  },
  'support-staff-ticket': {
    path: '/support/staff/tickets/:id',
    render: pageStaffTicket,
    requires: { support: true, admin: true },
  },
  'support-staff-macros': {
    path: '/support/staff/macros',
    render: pageStaffMacros,
    requires: { support: true, admin: true },
  },
  'support-staff-metrics': {
    path: '/support/staff/metrics',
    render: pageStaffMetrics,
    requires: { support: true, admin: true },
  },
  'support-staff-kb': {
    path: '/support/staff/kb',
    render: pageStaffKb,
    requires: { support: true, admin: true },
  },
  'support-staff-kb-article': {
    path: '/support/staff/kb/:id',
    render: pageStaffKbArticle,
    requires: { support: true, admin: true },
  },
  admin: { path: '/admin', render: adminIndex, requires: { admin: true } },
  'admin-users': { path: '/admin/users', render: pageAdminUsers, requires: { admin: true } },
  'admin-roles': { path: '/admin/roles', render: pageAdminRoles, requires: { admin: true } },
  'admin-audit': { path: '/admin/audit', render: pageAdminAudit, requires: { admin: true } },
  'admin-webhooks': {
    path: '/admin/webhooks',
    render: pageAdminWebhooks,
    requires: { admin: true },
  },
  'admin-filter': { path: '/admin/filter', render: pageAdminFilter, requires: { admin: true } },
  'admin-moderation': {
    path: '/admin/moderation',
    render: pageAdminModeration,
    requires: { admin: true },
  },
  'admin-csea': { path: '/admin/csea', render: pageAdminCsea, requires: { admin: true } },
  'admin-oauth': { path: '/admin/oauth', render: pageAdminOauth, requires: { admin: true } },
  'admin-games': { path: '/admin/games', render: pageAdminGames, requires: { admin: true } },
  'admin-health': { path: '/admin/health', render: pageAdminHealth, requires: { admin: true } },
});

function moduleEnabled(features, requires) {
  if (requires === undefined) return true;
  if (requires.identity && !features.modules.identity) return false;
  if (requires.oidc && !features.modules.oidc) return false;
  if (requires.games && !features.modules.games) return false;
  if (requires.safety && !features.modules.safety) return false;
  if (requires.support && !features.modules.support) return false;
  if (requires.admin && !features.modules.admin) return false;
  if (requires.password && !features.auth.methods.password) return false;
  if (requires.auth) {
    const methods = features.auth.methods;
    if (!methods.password && !methods.magic_link && !methods.passkeys) return false;
  }
  return true;
}

export function availablePages(features) {
  const out = [];
  for (const [id, page] of Object.entries(PAGES)) {
    if (moduleEnabled(features, page.requires)) out.push({ id, ...page });
  }
  return out;
}

export function matchPage(pages, path) {
  for (const page of pages) {
    const params = pathMatch(page.path, path);
    if (params !== null) return { page, params };
  }
  return null;
}

export function pathMatch(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i];
    const v = pathParts[i];
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(v);
    else if (p !== v) return null;
  }
  return params;
}

export function apiFor(bootstrap, fetcher) {
  return apiClient(bootstrap, fetcher);
}

export function renderPage(main, t, features, page, params, ctx) {
  clear(main);
  page.render(main, t, ctx, params);
  main.focus();
}
