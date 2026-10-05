import {
  admin,
  auth,
  factors,
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

function queryParam(ctx, name) {
  return new URLSearchParams(ctx.location.search).get(name) ?? '';
}

function itemsOf(data) {
  return data?.items ?? [];
}

const RETURN_TO = /^\/(?![/\\])[^\s\\]*$/u;

function safeReturnTo(value) {
  return typeof value === 'string' && value.length <= 2048 && RETURN_TO.test(value)
    ? value
    : undefined;
}

function finishSignIn(ctx, returnTo) {
  const target = safeReturnTo(returnTo);
  if (target === undefined) ctx.navigate('/account');
  else ctx.location.assign(target);
}

function problemOf(error) {
  return error instanceof ProblemFetchError ? error.problem : { code: 'INTERNAL_ERROR' };
}

function showProblem(view, part, error) {
  view.part(part).replaceChildren(view.problem(problemOf(error)));
}

function localDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleDateString();
}

function passkeysSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential?.parseRequestOptionsFromJSON === 'function'
  );
}

function passkeyCreationSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential?.parseCreationOptionsFromJSON === 'function'
  );
}

async function passkeyAssertion(a, secondFactor) {
  const started = await a.passkeyStart(secondFactor);
  const publicKey = window.PublicKeyCredential.parseRequestOptionsFromJSON(started.options);
  const credential = await navigator.credentials.get({ publicKey });
  return a.passkeyFinish(started.challenge, credential.toJSON());
}

function pageSignIn(view, t, ctx) {
  const a = auth(ctx.api);
  const { methods, social } = ctx.features.auth;
  const returnTo = safeReturnTo(queryParam(ctx, 'return_to'));
  view
    .show('password', methods.password)
    .show('magic_link', methods.magic_link)
    .show('passkeys', methods.passkeys && passkeysSupported())
    .show('social', social.length > 0);
  let challenge = '';
  const signedIn = (result) => {
    if (result?.status === 'second_factor_required') {
      challenge = result.challenge;
      view
        .show('second_totp', result.methods.includes('totp') || result.methods.includes('recovery'))
        .show('second_passkey', result.methods.includes('passkey') && passkeysSupported())
        .state('step', 'second-factor');
      return;
    }
    finishSignIn(ctx, returnTo);
  };
  view.state('step', 'methods').state('method', 'picker');
  view.on('choose-back', () => view.state('method', 'picker'));
  if (methods.password) {
    view.on('choose-password', () => view.state('method', 'password'));
    view.form('password', async (values) => {
      signedIn(await a.signInPassword(values.email, values.password));
    });
    view.form('second', async (values) => {
      const code = values.code.replaceAll(/\s/gu, '');
      await a.secondFactor(
        challenge,
        /^\d{6}$/u.test(code) ? { totp: code } : { recovery_code: code },
      );
      finishSignIn(ctx, returnTo);
    });
    view.on('second-passkey', () => {
      view.part('second-feedback').replaceChildren();
      void passkeyAssertion(a, challenge)
        .then(() => finishSignIn(ctx, returnTo))
        .catch((error) => showProblem(view, 'second-feedback', error));
    });
  }
  if (methods.magic_link) {
    view.on('choose-magic', () => view.state('method', 'magic'));
    view.form('magic', async (values, form) => {
      await a.magicLinkStart(values.email, returnTo);
      form.say('success');
    });
  }
  if (methods.passkeys && passkeysSupported()) {
    view.on('passkey', () => {
      view.state('method', 'pending');
      view.part('pending-feedback').replaceChildren();
      void passkeyAssertion(a)
        .then(() => finishSignIn(ctx, returnTo))
        .catch((error) => showProblem(view, 'pending-feedback', error));
    });
  }
  if (social.length === 0) return;
  view.list('social', social, (provider, row) => {
    row.fill({ name: provider.name });
    row.on('social', () => {
      view.state('method', 'pending');
      view.part('pending-feedback').replaceChildren();
      void a
        .socialStart(provider.id, returnTo)
        .then((started) => ctx.location.assign(started.url))
        .catch((error) => showProblem(view, 'pending-feedback', error));
    });
  });
}

function pageSignUp(view, t, ctx) {
  const a = auth(ctx.api);
  const { methods } = ctx.features.auth;
  const magicOnly = methods.magic_link && !methods.password;
  view.show('password', methods.password).show('magic_only', magicOnly);
  if (methods.password) {
    view.form('password', async (values, form) => {
      await a.signUpPassword({
        email: values.email,
        password: values.password,
        date_of_birth: values.date_of_birth,
        guardian_email: values.guardian_email || undefined,
      });
      form.say('success');
    });
  }
  if (magicOnly) {
    view.form('magic', async (values, form) => {
      await a.magicLinkStart(values.email);
      form.say('success');
    });
  }
}

function pageVerify(view, t, ctx) {
  const a = auth(ctx.api);
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('verify', async (values, form) => {
    await a.verifyEmail(values.token);
    form.say('success');
    ctx.navigate('/account');
  });
  view.form('resend', async (values, form) => {
    await a.startVerifyEmail(values.email);
    form.say('success');
  });
}

function pageMagicLink(view, t, ctx) {
  const a = auth(ctx.api);
  const token = queryParam(ctx, 'token');
  let signupToken = '';
  const next = (result) => {
    if (result.status === 'signed_in') {
      finishSignIn(ctx, result.return_to);
    } else if (result.status === 'choose_account') {
      view.list('accounts', result.accounts, (account, row) => {
        row.fill({ created: localDate(account.created_at) });
        row.on('choose', () => {
          view.part('choose-feedback').replaceChildren();
          void a
            .magicLinkVerify(token, account.user_id)
            .then(next)
            .catch((error) => showProblem(view, 'choose-feedback', error));
        });
      });
      view.state('step', 'choose');
    } else {
      signupToken = result.signup_token;
      view.state('step', 'signup');
    }
  };
  view.fill({ token }).state('step', 'confirm');
  view.form('confirm', async (values) => next(await a.magicLinkVerify(values.token)));
  view.form('signup', async (values) => {
    const created = await a.magicLinkSignup({
      signup_token: signupToken,
      date_of_birth: values.date_of_birth,
      guardian_email: values.guardian_email || undefined,
    });
    finishSignIn(ctx, created.return_to);
  });
}

function pageConfirmEmail(view, t, ctx) {
  const a = auth(ctx.api);
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('confirm', async (values, form) => {
    const result = await a.confirmEmailChange(values.token);
    form.say('success', { email: result.email });
  });
}

function pageSocialCallback(view, t, ctx, params) {
  const a = auth(ctx.api);
  const query = new URLSearchParams(ctx.location.search);
  let challenge = '';
  let returnTo;
  const next = (result) => {
    if (result.status === 'signed_in') {
      finishSignIn(ctx, result.return_to);
    } else if (result.status === 'linked') {
      ctx.navigate('/account/methods');
    } else {
      challenge = result.challenge;
      returnTo = result.return_to;
      view
        .show('needs_email', result.needs_email)
        .show('needs_date_of_birth', result.needs_date_of_birth)
        .state('step', 'signup');
    }
  };
  view.form('signup', async (values) => {
    const created = await a.socialSignup({
      challenge,
      email: values.email || undefined,
      date_of_birth: values.date_of_birth || undefined,
      guardian_email: values.guardian_email || undefined,
    });
    finishSignIn(ctx, created.return_to ?? returnTo);
  });
  void a
    .socialComplete({
      provider: params.provider,
      state: query.get('state') ?? '',
      code: query.get('code') ?? undefined,
      error: query.get('error') ?? undefined,
      params: Object.fromEntries(query),
    })
    .then(next)
    .catch((error) => {
      view.state('step', 'error');
      showProblem(view, 'feedback', error);
    });
}

function pageForgot(view, t, ctx) {
  const a = auth(ctx.api);
  view.form('forgot', async (values, form) => {
    await a.forgot(values.email);
    form.say('success');
  });
}

function pageReset(view, t, ctx) {
  const a = auth(ctx.api);
  let submitted = {};
  const next = (result) => {
    if (result?.status !== 'choose_account') {
      ctx.navigate('/account');
      return;
    }
    view.list('accounts', result.accounts, (account, row) => {
      row.fill({ created: localDate(account.created_at) });
      row.on('choose', () => {
        view.part('choose-feedback').replaceChildren();
        void a
          .reset(submitted.token, submitted.password, {
            keep_other_sessions: submitted.keep_other_sessions,
            user_id: account.user_id,
          })
          .then(next)
          .catch((error) => showProblem(view, 'choose-feedback', error));
      });
    });
    view.state('step', 'choose');
  };
  view.fill({ token: queryParam(ctx, 'token') }).state('step', 'form');
  view.form('reset', async (values) => {
    submitted = values;
    next(
      await a.reset(values.token, values.password, {
        keep_other_sessions: values.keep_other_sessions,
      }),
    );
  });
}

function pageGuardianApprove(view, t, ctx) {
  const a = auth(ctx.api);
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('approve', async (values, form) => {
    await a.guardianApprove(values.token, values.date_of_birth);
    form.say('success');
  });
}

function pageGuardianDecline(view, t, ctx) {
  const a = auth(ctx.api);
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('decline', async (values, form) => {
    await a.guardianDecline(values.token);
    form.say('success');
  });
}

function pageFamilySession(view, t, ctx) {
  const f = family(ctx.api);
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('session', async (values, form) => {
    await f.openSession(values.token);
    form.say('success');
    ctx.navigate('/family');
  });
}

function pageFamilyInvite(view, t, ctx) {
  const f = family(ctx.api);
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('invite', async (values, form) => {
    await f.acceptInvite(values.token, values.date_of_birth);
    form.say('success');
  });
}

function pageRevertEmail(view, t, ctx) {
  const a = auth(ctx.api);
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('revert', async (values, form) => {
    await a.revertEmail(values.token);
    form.say('success');
  });
}

function pageAccount(view, t, ctx) {
  const a = auth(ctx.api);
  view.on('sign-out', () => {
    void a
      .signOut()
      .then(() => ctx.navigate('/sign-in'))
      .catch(() => ctx.navigate('/sign-in'));
  });
}

function pageProfile(view, t, ctx) {
  const account = me(ctx.api);
  const load = () => {
    void account
      .get()
      .then((data) => {
        view
          .fill({ username: data?.username ?? '', email: data?.email ?? '' })
          .state('profile', 'ready');
      })
      .catch(() => view.state('profile', 'error'));
  };
  load();
  view.form('username', async (values, form) => {
    const result = await account.setUsername(values.username);
    form.say(result?.status === 'pending_guardian_approval' ? 'pending' : 'success');
    load();
  });
}

function pageEmail(view, t, ctx) {
  const account = me(ctx.api);
  view.form('email', async (values, form) => {
    await account.setEmail(values.email);
    form.say('success');
  });
}

function pageSecurity(view, t, ctx) {
  const a = auth(ctx.api);
  const f = factors(ctx.api);
  const { methods } = ctx.features.auth;
  const totp = Boolean(methods.totp);
  const passkeys = Boolean(methods.passkeys) && passkeyCreationSupported();
  view.show('totp', totp).show('passkeys', passkeys);

  let afterStepUp;
  const needingStepUp = (part, action) => () => {
    view.part(part).replaceChildren();
    void action().catch((error) => {
      if (problemOf(error).code !== 'STEP_UP_REQUIRED') {
        showProblem(view, part, error);
        return;
      }
      afterStepUp = () => {
        view.state('step-up', 'hidden');
        void action().catch((retried) => showProblem(view, part, retried));
      };
      view.state('step-up', 'prompt');
    });
  };
  view.state('step-up', 'hidden');
  view.form('step-up', async (values) => {
    const code = values.code.replaceAll(/\s/gu, '');
    await f.stepUp(/^\d{6}$/u.test(code) ? { totp: code } : { recovery_code: code });
    afterStepUp?.();
  });
  view.on('step-up-passkey', () => {
    view.part('step-up-feedback').replaceChildren();
    void f
      .stepUpPasskeyStart()
      .then(async (started) => {
        const publicKey = window.PublicKeyCredential.parseRequestOptionsFromJSON(started.options);
        const credential = await navigator.credentials.get({ publicKey });
        await f.stepUpPasskey(started.challenge, credential.toJSON());
        afterStepUp?.();
      })
      .catch((error) => showProblem(view, 'step-up-feedback', error));
  });

  const showCodes = (codes) =>
    view.list(
      'codes',
      codes.map((code) => ({ code })),
    );

  let totpChallenge = '';
  const load = () => {
    void f
      .list()
      .then((data) => {
        view.fill({ recovery_remaining: data.recovery_codes });
        if (totp) view.state('totp', data.totp ? 'on' : 'off');
        if (!passkeys) return;
        view.list('passkeys', data.passkeys, (key, row) => {
          row.fill({
            name: key.name,
            last_used: key.last_used_at === null ? '—' : localDate(key.last_used_at),
          });
          row.on('rename-passkey', () => {
            const name = row.el.querySelector('input[name="passkey_name"]')?.value.trim() ?? '';
            if (name === '') return;
            void f
              .renamePasskey(key.id, name)
              .then(load)
              .catch((error) => row.append(view.problem(problemOf(error))));
          });
          row.on('remove-passkey', () => {
            void f
              .removePasskey(key.id)
              .then(load)
              .catch((error) => row.append(view.problem(problemOf(error))));
          });
        });
      })
      .catch((error) => showProblem(view, 'factors-feedback', error));
  };
  load();

  view.form('password', async (values, form) => {
    await a.setPassword(values.next, values.current || undefined);
    form.say('success');
  });

  if (totp) {
    view.on('totp-start', () => {
      view.part('totp-feedback').replaceChildren();
      void f
        .totpStart()
        .then((started) => {
          totpChallenge = started.challenge;
          view.fill({ secret: started.secret, otpauth: started.otpauth }).state('totp', 'setup');
        })
        .catch((error) => showProblem(view, 'totp-feedback', error));
    });
    view.form('totp-confirm', async (values) => {
      const enabled = await f.totpConfirm(totpChallenge, values.code.replaceAll(/\s/gu, ''));
      showCodes(enabled.recovery_codes);
      load();
    });
    view.form('totp-disable', async (values) => {
      await f.totpDisable(values.code.replaceAll(/\s/gu, ''));
      load();
    });
  }
  view.on(
    'recovery',
    needingStepUp('recovery-feedback', async () => {
      showCodes((await f.recoveryCodes()).recovery_codes);
      load();
    }),
  );
  if (!passkeys) return;
  view.form('passkey-add', async (values, form) => {
    const started = await f.passkeyRegisterStart();
    const publicKey = window.PublicKeyCredential.parseCreationOptionsFromJSON(started.options);
    const credential = await navigator.credentials.create({ publicKey });
    await f.passkeyRegister(started.challenge, values.name, credential.toJSON());
    form.say('success');
    form.el.reset();
    load();
  });
}

function pageSessions(view, t, ctx) {
  const s = sessions(ctx.api);
  const load = () => {
    void s
      .list()
      .then((data) => {
        view.list('sessions', itemsOf(data), (session, row) => {
          row.fill({
            device: `${session.device.browser} · ${session.device.os}`,
            country: session.country ?? '',
            last_active: localDate(session.last_active_at),
            not_current: !session.current,
            current: session.current,
          });
          row.on('revoke', () => {
            void s
              .revoke(session.id)
              .then(load)
              .catch(() => row.append(view.problem()));
          });
        });
      })
      .catch(() => view.state('sessions', 'error'));
  };
  load();
  view.on('revoke-others', () => {
    void s.revokeOthers().then(load).catch(load);
  });
}

function pageMethods(view, t, ctx) {
  const { methods } = ctx.features.auth;
  for (const key of ['password', 'magic_link', 'passkeys', 'totp']) {
    view.show(key, Boolean(methods[key]));
  }
}

function pageNotifications(view, t, ctx) {
  const account = me(ctx.api);
  let categories = [];
  const show = (data) => {
    categories = data?.categories ?? [];
    view.list(
      'channels',
      categories.map((category) => ({
        id: `qtiauth-p-${category.id}`,
        channel: category.id,
        enabled: category.enabled,
        locked: !category.disableable,
        label: category.description,
      })),
    );
  };
  void account
    .notifications()
    .then(show)
    .catch(() => view.state('channels', 'error'));
  view.form('preferences', async (values, form) => {
    const changed = categories
      .filter((category) => category.disableable)
      .map((category) => ({ id: category.id, enabled: Boolean(values[category.id]) }));
    show(await account.setNotifications(changed));
    form.say('success');
  });
}

function pageLegal(view, t, ctx) {
  const account = me(ctx.api);
  void account
    .legal()
    .then((data) => {
      view.list('documents', data?.pending ?? [], (document, row) => {
        row.fill({
          path: `/legal/${encodeURIComponent(document.id)}`,
          summary: document.summary,
          effective: localDate(document.effective_at),
        });
        row.on('accept', () => {
          void account
            .acceptLegal([{ id: document.id, version: document.version }])
            .then(() => row.append(view.message('accepted')))
            .catch((error) => row.append(view.problem(problemOf(error))));
        });
      });
    })
    .catch(() => view.state('documents', 'error'));
}

function pageLegalDocument(view, t, ctx, params) {
  void me(ctx.api)
    .legalDocument(params.id)
    .then((document) => {
      view
        .fill({
          summary: document.summary,
          version: document.version,
          effective: localDate(document.effective_at),
          body: document.body,
        })
        .state('document', 'ready');
    })
    .catch(() => view.state('document', 'error'));
}

const EXPORT_POLL_MS = 5_000;

function pageData(view, t, ctx) {
  const account = me(ctx.api);
  const watchExport = (id) => {
    if (!view.el.isConnected) return;
    void account
      .exportStatus(id)
      .then((status) => {
        if (status.status === 'ready' && status.download_url !== null) {
          view.say('export-status', 'export-ready', { url: status.download_url });
        } else if (status.status === 'pending') {
          window.setTimeout(() => watchExport(id), EXPORT_POLL_MS);
        } else {
          view.say('export-status', 'export-emailed');
        }
      })
      .catch((error) => showProblem(view, 'export-status', error));
  };
  view.on('export', () => {
    view.part('export-status').replaceChildren();
    void account
      .export()
      .then((started) => {
        view.say('export-status', 'export-queued');
        watchExport(started.id);
      })
      .catch((error) => showProblem(view, 'export-status', error));
  });
  view.on('delete', () => {
    view.part('deletion-status').replaceChildren();
    void account
      .requestDeletion()
      .then(() => view.say('deletion-status', 'deletion-queued'))
      .catch((error) => showProblem(view, 'deletion-status', error));
  });
}

function pageFamilyLeave(view, t, ctx) {
  const account = me(ctx.api);
  const run = (action, message) => () => {
    view.part('status').replaceChildren();
    void action()
      .then((result) => view.say('status', message(result)))
      .catch((error) => showProblem(view, 'status', error));
  };
  view.on(
    'leave',
    run(
      () => account.requestFamilyRemoval(),
      (result) => (result?.status === 'pending_guardian_approval' ? 'pending' : 'left'),
    ),
  );
  view.on(
    'cancel',
    run(
      () => account.cancelFamilyRemoval(),
      () => 'cancelled',
    ),
  );
}

function pageFamily(view, t, ctx) {
  const f = family(ctx.api);
  void f
    .list()
    .then((data) => {
      view.list(
        'children',
        (data?.children ?? []).map((child) => ({
          path: `/family/${encodeURIComponent(child.id)}`,
          name: child.username ?? child.id,
        })),
      );
    })
    .catch(() => view.state('children', 'error'));
}

const CONTROLS = [
  'online_play',
  'in_game_chat',
  'user_generated_content',
  'purchases',
  'public_profile',
  'leaderboard_visible',
];

function pageChild(view, t, ctx, params) {
  const f = family(ctx.api);
  const act = (part, action) => () => {
    view.part(part).replaceChildren();
    void action()
      .then(load)
      .catch((error) => showProblem(view, part, error));
  };
  const loadSessions = () => {
    void f
      .childSessions(params.id)
      .then((data) => {
        view.list('sessions', itemsOf(data), (session, row) => {
          row.fill({
            device: `${session.device.browser} · ${session.device.os}`,
            last_active: localDate(session.last_active_at),
          });
          row.on(
            'revoke-session',
            act('sessions-feedback', () => f.revokeChildSession(params.id, session.id)),
          );
        });
      })
      .catch(() => view.state('sessions', 'error'));
  };
  function load() {
    void f
      .child(params.id)
      .then((child) => {
        view
          .fill({
            username: child.username ?? '',
            email: child.email,
            age_band: child.age_band,
            status: child.account_state,
            daily_playtime_minutes: child.controls.daily_playtime_minutes ?? '',
            ...Object.fromEntries(CONTROLS.map((name) => [name, child.controls[name]])),
          })
          .state('child', 'ready');
        view.list('apps', child.pending_app_approvals, (app, row) => {
          row.fill({ name: app.name, scopes: app.scopes.join(', ') });
          row.on(
            'approve-app',
            act('requests-feedback', () => f.approveApp(params.id, app.id)),
          );
          row.on(
            'decline-app',
            act('requests-feedback', () => f.declineApp(params.id, app.id)),
          );
        });
        const rename = child.pending_username_change;
        view.list('usernames', rename === null ? [] : [rename], (change, row) => {
          row.fill({ username: change.username });
          row.on(
            'approve-username',
            act('requests-feedback', () => f.approveUsername(params.id, change.id)),
          );
          row.on(
            'decline-username',
            act('requests-feedback', () => f.declineUsername(params.id, change.id)),
          );
        });
        const removal = child.pending_removal;
        view.list('removals', removal === null ? [] : [removal], (request, row) => {
          row.fill({ requested: localDate(request.requested_at) });
          row.on(
            'approve-removal',
            act('requests-feedback', () => f.approveRemoval(params.id)),
          );
          row.on(
            'decline-removal',
            act('requests-feedback', () => f.declineRemoval(params.id)),
          );
        });
      })
      .catch(() => view.state('child', 'error'));
    loadSessions();
  }
  view.form('controls', async (values, form) => {
    const minutes = String(values.daily_playtime_minutes ?? '').trim();
    await f.setControls(params.id, {
      ...Object.fromEntries(CONTROLS.map((name) => [name, Boolean(values[name])])),
      daily_playtime_minutes: minutes === '' ? null : Number(minutes),
    });
    form.say('success');
  });
  view.on(
    'revoke-all',
    act('sessions-feedback', () => f.revokeAllChildSessions(params.id)),
  );
  load();
}

const CONSENT_POLL_MS = 5_000;

function pageConsent(view, t, ctx) {
  const o = oauth(ctx.api);
  const requestId = queryParam(ctx, 'request_id');
  const decide = (decision) => {
    view.state('request', 'finishing');
    view.part('feedback').replaceChildren();
    void o
      .decideConsent(requestId, decision)
      .then((result) => ctx.location.assign(result.redirect_to))
      .catch((error) => {
        view.state('request', 'error');
        showProblem(view, 'feedback', error);
      });
  };
  const load = () => {
    if (!view.el.isConnected) return;
    void o
      .consentRequest(requestId)
      .then((request) => {
        view.fill({ name: request.client.name, verified: request.client.verified });
        view.list('scopes', request.scopes);
        if (request.state === 'approved') decide('allow');
        else if (request.state === 'declined') decide('deny');
        else if (request.state === 'pending_guardian') {
          view.state('request', 'waiting');
          window.setTimeout(load, CONSENT_POLL_MS);
        } else view.state('request', 'consent');
      })
      .catch(() => view.state('request', 'error'));
  };
  view.on('allow', () => decide('allow'));
  view.on('deny', () => decide('deny'));
  view.on('cancel', () => decide('deny'));
  load();
}

function pageDevice(view, t, ctx) {
  const o = oauth(ctx.api);
  let userCode = '';
  const lookup = async (presented) => {
    const request = await o.deviceRequest(presented);
    userCode = request.user_code;
    view.fill({
      name: request.client.name,
      user_code: request.user_code,
      verified: request.client.verified,
    });
    view.list('scopes', request.scopes);
    view.state('device', request.state === 'pending_guardian' ? 'waiting' : 'confirm');
  };
  const decide = (decision) => {
    view.part('feedback').replaceChildren();
    void o
      .decideDevice(userCode, decision)
      .then((result) =>
        view.state('device', result.status === 'pending_guardian' ? 'waiting' : result.status),
      )
      .catch((error) => showProblem(view, 'feedback', error));
  };
  view.form('code', (values) => lookup(values.user_code));
  view.on('allow', () => decide('allow'));
  view.on('deny', () => decide('deny'));
  const presented = queryParam(ctx, 'user_code');
  view.fill({ user_code: presented }).state('device', 'code');
  if (presented !== '') {
    void lookup(presented).catch((error) => showProblem(view, 'feedback', error));
  }
}

function pageApps(view, t, ctx) {
  const o = oauth(ctx.api);
  void o
    .authorizedApps()
    .then((data) => {
      view.list('apps', itemsOf(data), (app, row) => {
        row.fill({ name: app.name ?? app.client_id });
        row.on('revoke', () => {
          void o
            .revokeApp(app.client_id)
            .then(() => row.remove())
            .catch(() => row.append(view.problem()));
        });
      });
    })
    .catch(() => view.state('apps', 'error'));
}

function pageDeveloper(view, t, ctx) {
  const o = oauth(ctx.api);
  const load = () => {
    void o
      .developerClients()
      .then((data) => {
        view.list(
          'clients',
          itemsOf(data).map((client) => ({ name: client.name, client_id: client.client_id })),
        );
      })
      .catch(() => view.state('clients', 'error'));
  };
  load();
  view.form('create', async (values, form) => {
    const created = await o.createClient({
      name: values.name,
      type: values.type,
      redirect_uris: values.redirect_uris.split(/\s+/u).filter(Boolean),
    });
    form.say(created.secret === null ? 'success' : 'success-secret', {
      client_id: created.client_id,
      secret: created.secret,
    });
    form.el.reset();
    load();
  });
}

function pageGames(view, t, ctx) {
  void games(ctx.api)
    .owned()
    .then((data) => {
      view.list(
        'library',
        itemsOf(data).map((entry) => ({
          name: entry.name,
          products: entry.products.map((product) => product.name).join(', '),
        })),
      );
    })
    .catch(() => view.state('library', 'error'));
}

function pageRedeem(view, t, ctx) {
  const g = games(ctx.api);
  view.form('redeem', async (values, form) => {
    await g.redeem(values.code);
    form.say('success');
    form.el.reset();
  });
}

function gamePicker(view, ctx, load) {
  const g = games(ctx.api);
  void g
    .owned()
    .then((data) => view.list('games', itemsOf(data), (entry, row) => row.fill(entry)))
    .catch(() => view.state('rows', 'error'));
  view.form('game', async (values) => {
    view.list('rows', await load(g, values));
  });
}

function pageAchievements(view, t, ctx) {
  gamePicker(view, ctx, async (g, values) =>
    itemsOf(await g.achievements(values.game)).map((achievement) => ({
      label:
        achievement.unlocked_at === null
          ? `${achievement.name}: ${String(achievement.progress)}/${String(achievement.progress_target ?? 1)}`
          : `${achievement.name}: ${t('achievements.unlocked', 'unlocked')} ${localDate(achievement.unlocked_at)}`,
    })),
  );
}

function pageStats(view, t, ctx) {
  gamePicker(view, ctx, async (g, values) =>
    itemsOf(await g.stats(values.game)).map((stat) => ({
      label: `${stat.key}: ${String(stat.value)}`,
    })),
  );
}

function pageLeaderboards(view, t, ctx) {
  gamePicker(view, ctx, async (g, values) =>
    itemsOf(await g.leaderboard(values.game, values.stat, values.board)).map((entry) => ({
      label: `${String(entry.rank)}. ${entry.display_name}: ${String(entry.score)}`,
    })),
  );
}

function pageDevices(view, t, ctx) {
  const g = games(ctx.api);
  const load = (slug) => {
    void g
      .devices(slug)
      .then((data) => {
        view.list('devices', itemsOf(data), (device, row) => {
          row.fill({
            name: device.device_label ?? t('devices.unnamed', 'Unnamed device'),
            last_seen: localDate(device.last_seen_at ?? device.issued_at),
          });
          row.on('revoke', () => {
            void g
              .revokeDevice(slug, device.lease_id)
              .then(() => row.remove())
              .catch((error) => row.append(view.problem(problemOf(error))));
          });
        });
      })
      .catch(() => view.state('devices', 'error'));
  };
  void g
    .owned()
    .then((data) => view.list('games', itemsOf(data), (entry, row) => row.fill(entry)))
    .catch(() => view.state('devices', 'error'));
  view.form('game', (values) => {
    load(values.game);
    return Promise.resolve();
  });
}

function pageReport(view, t, ctx) {
  const r = reports(ctx.api);
  void r
    .taxonomy()
    .then((data) => {
      view.list(
        'reasons',
        (data?.types ?? []).flatMap((type) =>
          type.subtypes.map((subtype) => ({
            value: `${type.id}:${subtype.id}`,
            label: `${type.name}: ${subtype.name}`,
          })),
        ),
      );
    })
    .catch((error) => showProblem(view, 'reasons-feedback', error));
  view.fill({ target: queryParam(ctx, 'target'), target_type: queryParam(ctx, 'type') || 'user' });
  view.form('report', async (values, form) => {
    const [type, subtype] = values.reason.split(':');
    await r.submit({
      type,
      subtype,
      target: { type: values.target_type, id: values.target },
      note: values.note || null,
    });
    form.say('success');
    form.el.reset();
  });
}

function articleLinks(articles) {
  return articles.map((article) => ({
    path: `/kb/articles/${encodeURIComponent(article.slug)}`,
    title: article.title,
  }));
}

function pageKbHome(view, t, ctx) {
  const k = kb(ctx.api);
  void k
    .categories()
    .then((data) => {
      view.list(
        'categories',
        itemsOf(data).map((category) => ({
          path: `/kb/categories/${encodeURIComponent(category.slug)}`,
          name: category.name,
        })),
      );
    })
    .catch(() => view.state('categories', 'error'));
}

function pageKbCategory(view, t, ctx, params) {
  const k = kb(ctx.api);
  void k
    .category(params.slug)
    .then((data) => {
      view.fill({ name: data?.name ?? params.slug });
      view.list('articles', articleLinks(data?.articles?.items ?? []));
    })
    .catch(() => view.state('articles', 'error'));
}

function pageKbSearch(view, t, ctx) {
  const k = kb(ctx.api);
  view.form('search', async (values) => {
    const data = await k.search(values.q);
    view.list('results', articleLinks(itemsOf(data)));
  });
}

function pageKbArticle(view, t, ctx, params) {
  const k = kb(ctx.api);
  void k
    .article(params.slug)
    .then((data) => {
      if (data === null) {
        view.state('article', 'missing');
        return;
      }
      view.fill({
        title: data.title,
        category: data.category?.name ?? '',
        updated_at: data.updated_at,
      });
      renderKbArticleBody(view.part('body'), data.html);
      view.state('article', 'ready');
    })
    .catch(() => view.state('article', 'error'));
  const feedback = (helpful) => () => {
    void k
      .feedback(params.slug, helpful)
      .then(() => view.say('feedback', 'thanks'))
      .catch(() => view.part('feedback').appendChild(view.problem()));
  };
  view.on('helpful', feedback(true));
  view.on('not-helpful', feedback(false));
}

function renderKbArticleBody(body, html) {
  const parsed = new DOMParser().parseFromString(html ?? '', 'text/html');
  body.replaceChildren(...Array.from(parsed.body.childNodes));
}

function pageMyTickets(view, t, ctx) {
  const s = support(ctx.api);
  void s
    .listTickets()
    .then((data) => {
      view.list(
        'tickets',
        itemsOf(data).map((ticket) => ({
          path: `/tickets/${encodeURIComponent(ticket.id)}`,
          number: ticket.number,
          subject: ticket.subject,
          status: ticket.status,
        })),
      );
    })
    .catch(() => view.state('tickets', 'error'));
}

function loadCategories(view, request) {
  void request
    .then((data) => {
      view.list(
        'categories',
        itemsOf(data).map((category) => ({ id: category.id, name: category.name })),
      );
    })
    .catch(() => view.part('categories').appendChild(view.message('categories-error')));
}

function pageNewTicket(view, t, ctx) {
  const s = support(ctx.api);
  loadCategories(view, s.categories());
  view.form('ticket', async (values) => {
    const ticket = await s.createTicket({
      category_id: values.category_id,
      subject: values.subject,
      body: values.body,
    });
    ctx.navigate(`/tickets/${encodeURIComponent(ticket.id)}`);
  });
}

function messageRow(message, row) {
  row.show('staff', Boolean(message.staff)).fill({
    class: message.staff ? 'qtiauth-message qtiauth-message-staff' : 'qtiauth-message',
    created_at: message.created_at,
    body: message.body,
  });
}

function renderTicketDetail(detail, ticket, api, { reload, closed }) {
  const open = ticket.status !== 'closed';
  const unrated = ticket.rating == null;
  const attachments = ticket.attachments ?? [];
  const failed = () => detail.part('errors').appendChild(detail.problem());
  detail
    .fill({ status: ticket.status, priority: ticket.priority, created_at: ticket.created_at })
    .show('attachments', attachments.length > 0)
    .show('open', open)
    .show('unrated', unrated);
  detail.list('messages', ticket.messages ?? [], messageRow);
  if (attachments.length > 0) {
    detail.list('attachments', attachments, (attachment, row) => {
      row.fill({ filename: attachment.filename, content_type: attachment.content_type });
      row.on('download', () => {
        void api
          .downloadAttachment(ticket.id, attachment.id)
          .then((result) => {
            if (result?.url) window.open(result.url, '_blank', 'noopener');
          })
          .catch(() => row.append(row.problem()));
      });
    });
  }
  if (open) {
    detail.form('reply', async (values, form) => {
      await api.reply(ticket.id, values.body);
      form.say('success');
      reload();
    });
    detail.on('close', () => {
      void api.close(ticket.id).then(closed).catch(failed);
    });
    return;
  }
  detail.on('reopen', () => {
    void api.reopen(ticket.id).then(reload).catch(failed);
  });
  if (unrated) {
    detail.on('rate', (event, button) => {
      void api.rate(ticket.id, Number(button.value)).then(reload).catch(failed);
    });
  }
}

function pageTicket(view, t, ctx, params) {
  const s = support(ctx.api);
  void s
    .getTicket(params.id)
    .then((ticket) => {
      const path = `/tickets/${encodeURIComponent(ticket.id)}`;
      view.say('heading', 'heading', { number: ticket.number, subject: ticket.subject });
      renderTicketDetail(view.include('ticket', 'ticket'), ticket, s, {
        reload: () => ctx.navigate(path),
        closed: () => ctx.navigate('/tickets'),
      });
      view.state('ticket', 'ready');
    })
    .catch(() => view.state('ticket', 'error'));
}

function pageAppeal(view, t, ctx) {
  const s = support(ctx.api);
  view.fill({ action_id: queryParam(ctx, 'action_id') });
  view.form('appeal', async (values, form) => {
    const ticket = await s.createAppeal({
      action_id: values.action_id === '' ? undefined : values.action_id,
      body: values.body,
    });
    form.say('success');
    ctx.navigate(`/tickets/${encodeURIComponent(ticket.id)}`);
  });
}

function pageGuestStart(view, t, ctx) {
  const g = guestSupport(ctx.api);
  view.form('code', async (values, form) => {
    await g.requestCode(values.email, undefined);
    form.say('success');
    ctx.navigate(`/guest/verify?email=${encodeURIComponent(values.email)}`);
  });
}

function pageGuestVerify(view, t, ctx) {
  const g = guestSupport(ctx.api);
  view.fill({ email: queryParam(ctx, 'email') });
  loadCategories(view, g.categories());
  view.form('ticket', async (values, form) => {
    const result = await g.createTicket({
      email: values.email,
      code: values.code,
      category_id: values.category_id,
      subject: values.subject,
      body: values.body,
    });
    form.say('success', { number: result?.number ?? '' });
  });
}

function pageGuestView(view, t, ctx) {
  const g = guestSupport(ctx.api);
  const showTicket = async (token) => {
    const ticket = await g.viewTicket(token);
    const reload = () => {
      void showTicket(token).catch(() => view.part('ticket').appendChild(view.problem()));
    };
    const api = {
      reply: (_id, body) => g.reply(token, body),
      close: () => g.close(token),
      reopen: () => g.reopen(token),
      rate: (_id, rating) => g.rate(token, rating),
      downloadAttachment: (_id, attachmentId) => g.downloadAttachment(token, attachmentId),
    };
    renderTicketDetail(view.include('ticket', 'ticket'), ticket, api, {
      reload,
      closed: reload,
    });
    view.state('ticket', 'ready');
  };
  view.form('view', (values) => showTicket(values.token));
  const token = queryParam(ctx, 'token');
  view.fill({ token });
  if (token !== '') {
    void showTicket(token).catch((error) =>
      view.part('ticket').appendChild(view.problem(problemOf(error))),
    );
  }
}

function pageStaffQueue(view, t, ctx) {
  const s = staffSupport(ctx.api);
  void s
    .tickets()
    .then((data) => {
      view.list(
        'tickets',
        itemsOf(data).map((ticket) => ({
          path: `/staff/tickets/${encodeURIComponent(ticket.id)}`,
          number: ticket.number,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
        })),
      );
    })
    .catch(() => view.state('tickets', 'error'));
}

function pageStaffTicket(view, t, ctx, params) {
  const s = staffSupport(ctx.api);
  void s
    .ticket(params.id)
    .then((ticket) => {
      const reload = () => ctx.navigate(`/staff/tickets/${encodeURIComponent(ticket.id)}`);
      view.fill({
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        created_at: ticket.created_at,
      });
      view.list('messages', ticket.messages ?? [], messageRow);
      view.list('notes', ticket.notes ?? []);
      view.form('note', async (values, form) => {
        await s.addNote(ticket.id, values.body);
        form.say('success');
        reload();
      });
      view.form('reply', async (values, form) => {
        await s.reply(ticket.id, { body: values.body });
        form.say('success');
        reload();
      });
      view.state('ticket', 'ready');
    })
    .catch(() => view.state('ticket', 'error'));
}

function pageStaffMacros(view, t, ctx) {
  const s = staffSupport(ctx.api);
  const load = () => {
    void s
      .macros()
      .then((data) => {
        view.list('macros', itemsOf(data), (macro, row) => {
          row.fill({ name: macro.name });
          row.on('delete', () => {
            void s
              .deleteMacro(macro.id)
              .then(load)
              .catch(() => row.append(view.problem()));
          });
        });
      })
      .catch(() => view.state('macros', 'error'));
  };
  load();
  view.form('macro', async (values, form) => {
    await s.createMacro({ name: values.name, body: values.body });
    form.say('success');
    load();
  });
}

function pageStaffMetrics(view, t, ctx) {
  const s = staffSupport(ctx.api);
  void s
    .metrics()
    .then((data) => {
      if (data === null) {
        view.state('metrics', 'empty');
        return;
      }
      view
        .fill({
          first_response: data.first_response_seconds?.average ?? 0,
          resolution: data.resolution_seconds?.average ?? 0,
          guest: data.guest_tickets ?? 0,
        })
        .state('metrics', 'ready');
    })
    .catch(() => view.state('metrics', 'error'));
}

function pageStaffKb(view, t, ctx) {
  const k = staffKb(ctx.api);
  void k
    .articles()
    .then((data) => {
      view.list(
        'articles',
        itemsOf(data).map((article) => ({
          path: `/staff/kb/${encodeURIComponent(article.id)}`,
          title: article.title,
          status: article.status,
        })),
      );
    })
    .catch(() => view.state('articles', 'error'));
  view.form('article', async (values, form) => {
    const article = await k.createArticle({
      category_id: values.category_id,
      slug: values.slug,
      title: values.title,
      body: values.body,
    });
    form.say('success');
    ctx.navigate(`/staff/kb/${encodeURIComponent(article.id)}`);
  });
}

function pageStaffKbArticle(view, t, ctx, params) {
  const k = staffKb(ctx.api);
  void k
    .article(params.id)
    .then((article) => {
      if (article === null) {
        view.state('article', 'missing');
        return;
      }
      view.fill({ title: article.title, slug: article.slug, body: article.body });
      view.form('article', async (values, form) => {
        await k.updateArticle(article.id, {
          title: values.title,
          slug: values.slug,
          body: values.body,
        });
        form.say('success');
      });
      view.state('article', 'ready');
    })
    .catch(() => view.state('article', 'error'));
  void k
    .revisions(params.id)
    .then((data) => {
      view.list('revisions', itemsOf(data), (revision, row) => {
        row.fill({
          revision: revision.revision,
          title: revision.title,
          created_at: revision.created_at,
        });
        row.on('restore', () => {
          void k
            .restore(params.id, revision.revision)
            .then(() => ctx.navigate(`/staff/kb/${encodeURIComponent(params.id)}`))
            .catch(() => row.append(view.problem()));
        });
      });
    })
    .catch(() => view.state('revisions', 'error'));
}

function adminList(view, ctx, loader, toRow) {
  void loader(admin(ctx.api))
    .then((data) => view.list('rows', itemsOf(data).map(toRow)))
    .catch(() => view.state('rows', 'error'));
}

function pageAdminUsers(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.users(),
    (user) => ({
      path: `/admin/users/${encodeURIComponent(user.id)}`,
      username: user.username ?? user.id,
      email: `${user.email} (${user.state})`,
    }),
  );
}

function pageAdminRoles(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.roles(),
    (role) => ({ name: role.name }),
  );
}

function pageAdminAudit(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.audit(),
    (entry) => ({
      at: new Date(entry.occurred_at).toLocaleString(),
      action: `${entry.action} ${entry.target_type}:${entry.target_id}`,
      actor: `${entry.actor_type}:${entry.actor_id}`,
    }),
  );
}

function pageAdminWebhooks(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.webhooks(),
    (hook) => ({
      path: `/admin/webhooks/${encodeURIComponent(hook.id)}`,
      url: hook.url,
      events: hook.events.join(', '),
    }),
  );
}

function pageAdminFilter(view, t, ctx) {
  const a = admin(ctx.api);
  const sections = [
    ['blocks', () => a.filterBlocks(), (row) => `${row.normalized}: ${row.decision} (${row.rule})`],
    ['allowlist', () => a.filterAllowlist(), (row) => row.word],
    ['blocklist', () => a.filterBlocklist(), (row) => row.word],
  ];
  for (const [slot, loader, label] of sections) {
    void loader()
      .then((data) => {
        view.list(
          slot,
          itemsOf(data).map((row) => ({ label: label(row) })),
        );
      })
      .catch(() => view.state(slot, 'error'));
  }
}

function pageAdminModeration(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.moderationQueue(),
    (report) => ({
      path: `/admin/moderation/${encodeURIComponent(report.id)}`,
      kind: `${report.priority}: ${report.type}/${report.subtype}`,
      target: `${report.target.type}:${report.target.id}`,
    }),
  );
}

function pageAdminCsea(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.cseaCases(),
    (row) => ({
      path: `/admin/csea/${encodeURIComponent(row.id)}`,
      opened_at: localDate(row.created_at),
      status: row.overdue ? `${row.status} (${t('admin.csea.overdue', 'overdue')})` : row.status,
    }),
  );
}

function pageAdminOauth(view, t, ctx) {
  const a = admin(ctx.api);
  const load = () => {
    void a
      .oauthClients()
      .then((data) => {
        view.list('rows', itemsOf(data), (client, row) => {
          row.fill({
            path: `/admin/oauth/${encodeURIComponent(client.client_id)}`,
            name: client.name,
            client_id: client.client_id,
            status: client.suspended
              ? t('admin.oauth.suspended', 'suspended')
              : client.verified
                ? t('admin.oauth.verified', 'verified')
                : t('admin.oauth.unverified', 'unverified'),
            verified: client.verified,
            suspended: client.suspended,
            active: !client.suspended,
          });
          const act = (action) => () => {
            void action(client.client_id)
              .then(load)
              .catch((error) => row.append(view.problem(problemOf(error))));
          };
          row.on(
            'verify',
            act((id) => a.verifyOauthClient(id)),
          );
          row.on(
            'suspend',
            act((id) => a.suspendOauthClient(id)),
          );
          row.on(
            'unsuspend',
            act((id) => a.unsuspendOauthClient(id)),
          );
        });
      })
      .catch(() => view.state('rows', 'error'));
  };
  load();
}

function pageAdminGames(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.gamesCatalog(),
    (game) => ({ title: `${game.name} (${game.status})` }),
  );
}

function pageAdminHealth(view, t, ctx) {
  void admin(ctx.api)
    .health()
    .then((data) => {
      view.fill({ status: data.status });
      view.list(
        'services',
        data.services.map((service) => ({ name: service.name, instances: service.instances })),
      );
    })
    .catch(() => view.state('services', 'error'));
}

function reasonOf(view) {
  return view.part('reason').querySelector('input')?.value.trim() ?? '';
}

function adminAction(view, load, part, action) {
  return () => {
    view.part(part).replaceChildren();
    void action()
      .then(load)
      .catch((error) => showProblem(view, part, error));
  };
}

function when(value) {
  return value === null || value === undefined ? '—' : new Date(value).toLocaleString();
}

function pageAdminUser(view, t, ctx, params) {
  const a = admin(ctx.api);
  const reasoned = (call) =>
    adminAction(view, load, 'actions-feedback', () => call(params.id, reasonOf(view)));
  function load() {
    void a
      .user(params.id)
      .then((detail) => {
        const user = detail.profile;
        view
          .fill({
            email: user.email,
            username: user.username ?? '—',
            state: user.state,
            age_band: user.age_band,
            date_of_birth: user.date_of_birth,
            created: when(user.created_at),
            locked_until: when(user.locked_until),
            roles: user.roles.map((role) => role.name).join(', ') || '—',
          })
          .state('user', 'ready');
        view.list(
          'methods',
          detail.sign_in_methods.map((method) => ({
            label: `${method.type}, last used ${when(method.last_used_at)}`,
          })),
        );
        view.list(
          'sessions',
          detail.sessions.map((session) => ({
            label: `${session.device.browser} · ${session.device.os}, ${session.country ?? ''} ${when(session.last_active_at)}`,
          })),
        );
        view.list(
          'history',
          detail.staff_actions.map((entry) => ({
            label: `${when(entry.created_at)} ${entry.action}: ${entry.reason}`,
          })),
        );
      })
      .catch(() => view.state('user', 'error'));
    void a
      .userEntitlements(params.id)
      .then((data) =>
        view.list(
          'entitlements',
          itemsOf(data).map((entitlement) => ({
            path: `/admin/entitlements/${encodeURIComponent(entitlement.id)}`,
            label: `${entitlement.game_slug} / ${entitlement.product_slug}${entitlement.revoked_at === null ? '' : ' (revoked)'}`,
          })),
        ),
      )
      .catch(() => view.list('entitlements', []));
  }
  view.on(
    'ban',
    reasoned((id, reason) => a.banUser(id, reason)),
  );
  view.on(
    'unban',
    reasoned((id, reason) => a.unbanUser(id, reason)),
  );
  view.on(
    'unlock',
    reasoned((id, reason) => a.unlockUser(id, reason)),
  );
  view.on(
    'reauth',
    reasoned((id, reason) => a.forceReauth(id, reason)),
  );
  view.on(
    'revoke-sessions',
    reasoned((id, reason) => a.revokeUserSessions(id, reason)),
  );
  view.on(
    'username-reset',
    reasoned((id, reason) => a.resetUsername(id, reason)),
  );
  view.on(
    'lock',
    reasoned((id, reason) => {
      const until = view.part('lock-until').querySelector('input')?.value ?? '';
      return a.lockUser(id, reason, until === '' ? '' : new Date(until).toISOString());
    }),
  );
  load();
}

function pageAdminReport(view, t, ctx, params) {
  const a = admin(ctx.api);
  function load() {
    void a
      .report(params.id)
      .then((report) => {
        view
          .fill({
            kind: `${report.type} / ${report.subtype}`,
            priority: report.priority,
            status: report.status,
            source: report.source,
            target: `${report.target.type}: ${report.target.id}`,
            target_path:
              report.target.user_id === null
                ? '/admin/moderation'
                : `/admin/users/${encodeURIComponent(report.target.user_id)}`,
            note: report.note ?? '—',
            snapshot: report.snapshot?.content ?? '—',
            created: when(report.created_at),
            sla: when(report.sla_deadline),
            outcome: report.outcome ?? '—',
          })
          .state('report', 'ready');
        view.list(
          'actions',
          report.actions.map((action) => ({
            label: `${when(action.created_at)} ${action.action} (${action.rule_id}): ${action.status}`,
          })),
        );
      })
      .catch(() => view.state('report', 'error'));
  }
  void a
    .safetyCatalog()
    .then((catalog) => {
      view.list(
        'action-options',
        catalog.actions.filter((action) => action.enabled),
        (action, row) => row.fill({ value: action.id, label: action.name }),
      );
      view.list('rule-options', catalog.rules, (rule, row) =>
        row.fill({ value: rule.id, label: rule.name }),
      );
    })
    .catch((error) => showProblem(view, 'act-feedback', error));
  view.form('act', async (values, form) => {
    await a.reportAction(params.id, {
      action: values.action,
      rule_id: values.rule_id,
      ...(values.expires_at === ''
        ? {}
        : { expires_at: new Date(values.expires_at).toISOString() }),
    });
    form.say('success');
    load();
  });
  view.on(
    'dismiss',
    adminAction(view, load, 'act-feedback', () => a.dismissReport(params.id)),
  );
  load();
}

function pageAdminAppeals(view, t, ctx) {
  const a = admin(ctx.api);
  function load() {
    void a
      .appeals()
      .then((data) => {
        view.list('rows', itemsOf(data), (appeal, row) => {
          row.fill({ created: when(appeal.created_at), body: appeal.body });
          const resolve = (outcome) => () => {
            void a
              .resolveAppeal(appeal.id, outcome)
              .then(load)
              .catch((error) => row.append(view.problem(problemOf(error))));
          };
          row.on('lift', resolve('lifted'));
          row.on('uphold', resolve('upheld'));
        });
      })
      .catch(() => view.state('rows', 'error'));
  }
  load();
}

function pageAdminCseaCase(view, t, ctx, params) {
  const a = admin(ctx.api);
  function load() {
    void a
      .cseaCase(params.id)
      .then((record) => {
        view
          .fill({
            status: record.status,
            nca_priority: record.nca_priority,
            deadline: when(record.submission_deadline),
            nca_reference: record.nca_reference ?? '—',
            evidence_until: when(record.evidence_until),
            target: `${record.target.type}: ${record.target.id}`,
            portal: record.nca_portal_url,
          })
          .state('case', 'ready');
        view.list(
          'evidence',
          record.evidence.map((item) => ({
            label: `${item.kind} (${item.content_type}), ${when(item.created_at)}`,
            content: item.content,
          })),
        );
      })
      .catch(() => view.state('case', 'error'));
  }
  view.on(
    'protect',
    adminAction(view, load, 'case-feedback', () => a.protectCseaCase(params.id)),
  );
  view.form('submit', async (values, form) => {
    await a.submitCseaCase(params.id, {
      nca_reference: values.nca_reference,
      declaration: values.declaration === true,
    });
    form.say('success');
    load();
  });
  view.form('close', async (values, form) => {
    await a.closeCseaCase(params.id, values.reason);
    form.say('success');
    load();
  });
  load();
}

function pageAdminOauthClient(view, t, ctx, params) {
  const a = admin(ctx.api);
  function load() {
    void a
      .oauthClient(params.id)
      .then((client) => {
        view
          .fill({
            name: client.name,
            client_id: client.client_id,
            description: client.description || '—',
            type: client.type,
            redirect_uris: client.redirect_uris.join(' ') || '—',
            created: when(client.created_at),
            status: client.suspended ? 'suspended' : client.verified ? 'verified' : 'unverified',
            verified: client.verified,
            suspended: client.suspended,
            active: !client.suspended,
          })
          .state('client', 'ready');
      })
      .catch(() => view.state('client', 'error'));
  }
  const act = (call) => adminAction(view, load, 'client-feedback', () => call(params.id));
  view.on(
    'verify',
    act((id) => a.verifyOauthClient(id)),
  );
  view.on(
    'suspend',
    act((id) => a.suspendOauthClient(id)),
  );
  view.on(
    'unsuspend',
    act((id) => a.unsuspendOauthClient(id)),
  );
  load();
}

function pageAdminEntitlement(view, t, ctx, params) {
  const a = admin(ctx.api);
  function load() {
    void a
      .entitlement(params.id)
      .then((entitlement) => {
        view
          .fill({
            product: `${entitlement.game_slug} / ${entitlement.product_slug}`,
            user_path: `/admin/users/${encodeURIComponent(entitlement.user_id)}`,
            user_id: entitlement.user_id,
            source: entitlement.source,
            granted: when(entitlement.granted_at),
            expires: when(entitlement.expires_at),
            revoked:
              entitlement.revoked_at === null
                ? '—'
                : `${when(entitlement.revoked_at)}: ${entitlement.revoke_reason ?? ''}`,
          })
          .state('entitlement', 'ready');
      })
      .catch(() => view.state('entitlement', 'error'));
  }
  view.form('revoke', async (values, form) => {
    await a.revokeEntitlement(params.id, values.reason);
    form.say('success');
    load();
  });
  load();
}

function pageAdminWebhook(view, t, ctx, params) {
  const a = admin(ctx.api);
  function load() {
    void a
      .webhook(params.id)
      .then((hook) => {
        view
          .fill({
            url: hook.url,
            description: hook.description || '—',
            events: hook.events.join(', '),
            format: hook.format,
            status: hook.enabled ? 'enabled' : `disabled: ${hook.disabled_reason ?? ''}`,
            failures: hook.consecutive_failures,
            enabled: hook.enabled,
            disabled: !hook.enabled,
          })
          .state('webhook', 'ready');
      })
      .catch(() => view.state('webhook', 'error'));
    void a
      .webhookDeliveries(params.id)
      .then((data) =>
        view.list(
          'deliveries',
          itemsOf(data).map((delivery) => ({
            label: `${when(delivery.queued_at)} ${delivery.event_type}: ${delivery.status} after ${String(delivery.attempts)} attempts${delivery.last_error === null ? '' : ` (${delivery.last_error})`}`,
          })),
        ),
      )
      .catch(() => view.list('deliveries', []));
  }
  const act = (call) => adminAction(view, load, 'webhook-feedback', () => call(params.id));
  view.on(
    'enable',
    act((id) => a.setWebhookEnabled(id, true)),
  );
  view.on(
    'disable',
    act((id) => a.setWebhookEnabled(id, false)),
  );
  view.on(
    'test',
    act((id) => a.testWebhook(id)),
  );
  load();
}

export const PAGES = Object.freeze({
  'sign-in': { path: '/sign-in', render: pageSignIn, requires: { auth: true } },
  'sign-up': { path: '/sign-up', render: pageSignUp, requires: { auth: true } },
  verify: { path: '/verify', render: pageVerify },
  'magic-link': { path: '/magic-link', render: pageMagicLink, requires: { auth: true } },
  'confirm-email': {
    path: '/confirm-email',
    render: pageConfirmEmail,
    requires: { identity: true },
  },
  'social-callback': {
    path: '/auth/social/:provider/callback',
    render: pageSocialCallback,
    requires: { auth: true },
  },
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
  'legal-document': {
    path: '/legal/:id',
    render: pageLegalDocument,
    requires: { identity: true },
  },
  data: { path: '/account/data', render: pageData, requires: { identity: true } },
  family: { path: '/family', render: pageFamily, requires: { identity: true } },
  'family-leave': { path: '/family/leave', render: pageFamilyLeave, requires: { identity: true } },
  child: { path: '/family/:id', render: pageChild, requires: { identity: true } },
  'family-session': { path: '/family/session', render: pageFamilySession },
  'family-invite': { path: '/family/invite', render: pageFamilyInvite },
  waiting: { path: '/waiting' },
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
  support: { path: '/', surface: 'support', requires: { support: true } },
  'support-kb': {
    path: '/kb',
    render: pageKbHome,
    surface: 'support',
    requires: { support: true },
  },
  'support-kb-search': {
    path: '/kb/search',
    render: pageKbSearch,
    surface: 'support',
    requires: { support: true },
  },
  'support-kb-category': {
    path: '/kb/categories/:slug',
    render: pageKbCategory,
    surface: 'support',
    requires: { support: true },
  },
  'support-kb-article': {
    path: '/kb/articles/:slug',
    render: pageKbArticle,
    surface: 'support',
    requires: { support: true },
  },
  'support-tickets': {
    path: '/tickets',
    render: pageMyTickets,
    surface: 'support',
    requires: { support: true, identity: true },
  },
  'support-tickets-new': {
    path: '/tickets/new',
    render: pageNewTicket,
    surface: 'support',
    requires: { support: true, identity: true },
  },
  'support-ticket': {
    path: '/tickets/:id',
    render: pageTicket,
    surface: 'support',
    requires: { support: true, identity: true },
  },
  'support-appeal': {
    path: '/appeals/new',
    render: pageAppeal,
    surface: 'support',
    requires: { support: true, identity: true },
  },
  'support-guest': {
    path: '/guest/start',
    render: pageGuestStart,
    surface: 'support',
    requires: { support: true },
  },
  'support-guest-verify': {
    path: '/guest/verify',
    render: pageGuestVerify,
    surface: 'support',
    requires: { support: true },
  },
  'support-guest-view': {
    path: '/guest/view',
    render: pageGuestView,
    surface: 'support',
    requires: { support: true },
  },
  'support-staff': { path: '/staff', surface: 'support', requires: { support: true, admin: true } },
  'support-staff-tickets': {
    path: '/staff/tickets',
    render: pageStaffQueue,
    surface: 'support',
    requires: { support: true, admin: true },
  },
  'support-staff-ticket': {
    path: '/staff/tickets/:id',
    render: pageStaffTicket,
    surface: 'support',
    requires: { support: true, admin: true },
  },
  'support-staff-macros': {
    path: '/staff/macros',
    render: pageStaffMacros,
    surface: 'support',
    requires: { support: true, admin: true },
  },
  'support-staff-metrics': {
    path: '/staff/metrics',
    render: pageStaffMetrics,
    surface: 'support',
    requires: { support: true, admin: true },
  },
  'support-staff-kb': {
    path: '/staff/kb',
    render: pageStaffKb,
    surface: 'support',
    requires: { support: true, admin: true },
  },
  'support-staff-kb-article': {
    path: '/staff/kb/:id',
    render: pageStaffKbArticle,
    surface: 'support',
    requires: { support: true, admin: true },
  },
  admin: { path: '/admin', requires: { admin: true } },
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
  'admin-user': { path: '/admin/users/:id', render: pageAdminUser, requires: { admin: true } },
  'admin-report': {
    path: '/admin/moderation/:id',
    render: pageAdminReport,
    requires: { admin: true },
  },
  'admin-appeals': { path: '/admin/appeals', render: pageAdminAppeals, requires: { admin: true } },
  'admin-csea-case': {
    path: '/admin/csea/:id',
    render: pageAdminCseaCase,
    requires: { admin: true },
  },
  'admin-oauth-client': {
    path: '/admin/oauth/:id',
    render: pageAdminOauthClient,
    requires: { admin: true },
  },
  'admin-entitlement': {
    path: '/admin/entitlements/:id',
    render: pageAdminEntitlement,
    requires: { admin: true },
  },
  'admin-webhook': {
    path: '/admin/webhooks/:id',
    render: pageAdminWebhook,
    requires: { admin: true },
  },
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

export function availablePages(features, surface) {
  const out = [];
  for (const [id, page] of Object.entries(PAGES)) {
    if (surface !== undefined && (page.surface ?? 'account') !== surface) continue;
    if (moduleEnabled(features, page.requires)) out.push({ id, ...page });
  }
  return out;
}

export function matchPage(pages, path) {
  let best = null;
  let bestScore = -1;
  for (const page of pages) {
    const params = pathMatch(page.path, path);
    if (params === null) continue;
    const score = literalScore(page.path);
    if (score > bestScore) {
      best = { page, params };
      bestScore = score;
    }
  }
  return best;
}

function literalScore(pattern) {
  let score = 0;
  for (const part of pattern.split('/')) {
    if (part && !part.startsWith(':')) score += 1;
  }
  return score;
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
