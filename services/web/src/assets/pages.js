import {
  admin,
  auth,
  family,
  games,
  guestSupport,
  kb,
  me,
  oauth,
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

function pageSignIn(view, t, ctx) {
  const a = auth(ctx.api);
  const { methods, social } = ctx.features.auth;
  view
    .show('password', methods.password)
    .show('magic_link', methods.magic_link)
    .show('passkeys', methods.passkeys)
    .show('social', social.length > 0);
  if (methods.password) {
    view.form('password', async (values, form) => {
      await a.signInPassword(values.email, values.password);
      form.say('success');
      ctx.navigate('/account');
    });
  }
  if (methods.magic_link) {
    view.form('magic', async (values, form) => {
      await a.magicLinkStart(values.email);
      form.say('success');
    });
  }
  if (methods.passkeys) {
    view.on('passkey', () => {
      view.part('passkey-feedback').appendChild(view.message('passkey-pending'));
    });
  }
  view.list(
    'social',
    social.map((provider) => ({
      name: provider.name,
      href: `${ctx.apiBase}/api/v1/auth/social/${encodeURIComponent(provider.id)}/start`,
    })),
  );
}

function pageSignUp(view, t, ctx) {
  const a = auth(ctx.api);
  const { methods } = ctx.features.auth;
  const magicOnly = methods.magic_link && !methods.password;
  view.show('password', methods.password).show('magic_only', magicOnly);
  if (methods.password) {
    view.form('password', async (values, form) => {
      await a.signUpPassword(values.email, values.password, values.name);
      form.say('success');
      ctx.navigate('/verify');
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
  view.on('resend', () => {
    void a.startVerifyEmail().catch(() => {
      view.part('resend-feedback').appendChild(view.problem());
    });
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
  view.fill({ token: queryParam(ctx, 'token') });
  view.form('reset', async (values, form) => {
    await a.reset(values.token, values.password);
    form.say('success');
    ctx.navigate('/sign-in');
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
  void account
    .get()
    .then((data) => {
      view
        .fill({ name: data?.name ?? '', username: data?.username ?? '', email: data?.email ?? '' })
        .state('profile', 'ready');
    })
    .catch(() => view.state('profile', 'error'));
  view.form('username', async (values, form) => {
    await account.setUsername(values.username);
    form.say('success');
  });
}

function pageEmail(view, t, ctx) {
  const a = auth(ctx.api);
  view.form('email', async (values, form) => {
    await a.changeEmail(values.email, values.password);
    form.say('success');
  });
}

function pageSecurity(view, t, ctx) {
  const a = auth(ctx.api);
  view.form('password', async (values, form) => {
    await a.changePassword(values.current, values.next);
    form.say('success');
  });
}

function pageSessions(view, t, ctx) {
  const s = sessions(ctx.api);
  const load = () => {
    void s
      .list()
      .then((data) => {
        view.list('sessions', itemsOf(data), (session, row) => {
          row.fill({ user_agent: session.user_agent, ip: session.ip ?? '' });
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
  void account
    .notifications()
    .then((data) => {
      const channels = Object.entries(data?.preferences ?? {});
      view.list(
        'channels',
        channels.map(([channel, enabled]) => ({
          id: `qtiauth-p-${channel}`,
          channel,
          enabled: Boolean(enabled),
          label: t(`notifications.channel.${channel}`, channel),
        })),
      );
    })
    .catch(() => view.state('channels', 'error'));
  view.form('preferences', async (values, form) => {
    await account.setNotifications(values);
    form.say('success');
  });
}

function pageLegal(view, t, ctx) {
  const account = me(ctx.api);
  void account
    .legal()
    .then((data) => {
      view.list('documents', data?.documents ?? [], (document, row) => {
        row.fill({ url: document.url, title: document.title });
        row.on('accept', () => {
          void account
            .acceptLegal(document.id, document.version)
            .then(() => row.append(view.message('accepted')))
            .catch(() => row.append(view.problem()));
        });
      });
    })
    .catch(() => view.state('documents', 'error'));
}

function pageData(view, t, ctx) {
  const account = me(ctx.api);
  const request = (part, message, action) => () => {
    view.part(part).replaceChildren();
    void action()
      .then((result) => view.say(part, message, result ?? {}))
      .catch(() => view.part(part).appendChild(view.problem()));
  };
  view.on(
    'export',
    request('export-status', 'export-queued', () => account.export()),
  );
  view.on(
    'delete',
    request('deletion-status', 'deletion-queued', () => account.requestDeletion()),
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
          name: child.display_name ?? child.username ?? child.id,
        })),
      );
    })
    .catch(() => view.state('children', 'error'));
}

function pageChild(view, t, ctx, params) {
  const f = family(ctx.api);
  void f
    .child(params.id)
    .then((data) => {
      view
        .fill({
          username: data?.username ?? '',
          age_band: data?.age_band ?? '',
          status: data?.status ?? '',
        })
        .state('child', 'ready');
    })
    .catch(() => view.state('child', 'error'));
}

function pageConsent(view, t, ctx) {
  view.fill({
    client_id: queryParam(ctx, 'client_id'),
    scope: queryParam(ctx, 'scope'),
    authorize_url: `${ctx.apiBase}/api/v1/oauth/authorize`,
  });
}

function pageDevice(view, t, ctx) {
  const o = oauth(ctx.api);
  view.form('pair', async (values, form) => {
    await o.devicePair(values.user_code);
    form.say('success');
  });
}

function pageApps(view, t, ctx) {
  const o = oauth(ctx.api);
  void o
    .authorizedApps()
    .then((data) => {
      view.list('apps', itemsOf(data), (app, row) => {
        row.fill({ name: app.client_name ?? app.client_id });
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
  void o
    .developerClients()
    .then((data) => {
      view.list(
        'clients',
        itemsOf(data).map((client) => ({
          name: client.name ?? client.client_id,
          client_id: client.client_id,
        })),
      );
    })
    .catch(() => view.state('clients', 'error'));
  view.form('create', async (values, form) => {
    await o.createClient({
      name: values.name,
      redirect_uris: values.redirect_uris.split(/\s+/u).filter(Boolean),
    });
    form.say('success');
  });
}

function pageGames(view, t, ctx) {
  const g = games(ctx.api);
  void g
    .library()
    .then((data) => {
      view.list(
        'library',
        itemsOf(data).map((entry) => ({ title: entry.title ?? entry.game_id })),
      );
    })
    .catch(() => view.state('library', 'error'));
}

function pageRedeem(view, t, ctx) {
  const g = games(ctx.api);
  view.form('redeem', async (values, form) => {
    const result = await g.redeem(values.code);
    form.say('success', { title: result?.title ?? 'game' });
  });
}

function pageDevices(view, t, ctx) {
  const g = games(ctx.api);
  void g
    .devices()
    .then((data) => {
      view.list('devices', itemsOf(data), (device, row) => {
        row.fill({ name: device.name ?? device.id, platform: device.platform ?? '' });
        row.on('revoke', () => {
          void g
            .revokeDevice(device.id)
            .then(() => row.remove())
            .catch(() => row.append(view.problem()));
        });
      });
    })
    .catch(() => view.state('devices', 'error'));
}

function gamePicker(view, ctx, action) {
  const g = games(ctx.api);
  view.form('game', async (values) => {
    const data = await action(g, values.game_id);
    view.list(
      'rows',
      itemsOf(data).map((row) => ({ label: row.title ?? row.name ?? JSON.stringify(row) })),
    );
  });
}

function pageAchievements(view, t, ctx) {
  gamePicker(view, ctx, (g, id) => g.achievements(id));
}

function pageStats(view, t, ctx) {
  gamePicker(view, ctx, (g, id) => g.stats(id));
}

function pageLeaderboards(view, t, ctx) {
  gamePicker(view, ctx, (g, id) => g.leaderboards(id));
}

function pageReport(view, t, ctx) {
  const r = reports(ctx.api);
  view.form('report', async (values, form) => {
    await r.submit({ target: values.target, reason: values.reason, detail: values.detail });
    form.say('success');
  });
}

function articleLinks(articles) {
  return articles.map((article) => ({
    path: `/support/kb/articles/${encodeURIComponent(article.slug)}`,
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
          path: `/support/kb/categories/${encodeURIComponent(category.slug)}`,
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
          path: `/support/tickets/${encodeURIComponent(ticket.id)}`,
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
    ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
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
      const path = `/support/tickets/${encodeURIComponent(ticket.id)}`;
      view.say('heading', 'heading', { number: ticket.number, subject: ticket.subject });
      renderTicketDetail(view.include('ticket', 'ticket'), ticket, s, {
        reload: () => ctx.navigate(path),
        closed: () => ctx.navigate('/support/tickets'),
      });
      view.state('ticket', 'ready');
    })
    .catch(() => view.state('ticket', 'error'));
}

function pageAppeal(view, t, ctx) {
  const s = support(ctx.api);
  view.form('appeal', async (values, form) => {
    const ticket = await s.createAppeal({
      action_id: values.action_id === '' ? undefined : values.action_id,
      body: values.body,
    });
    form.say('success');
    ctx.navigate(`/support/tickets/${encodeURIComponent(ticket.id)}`);
  });
}

function pageGuestStart(view, t, ctx) {
  const g = guestSupport(ctx.api);
  view.form('code', async (values, form) => {
    await g.requestCode(values.email, undefined);
    form.say('success');
    ctx.navigate(`/support/guest/verify?email=${encodeURIComponent(values.email)}`);
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
}

function pageStaffQueue(view, t, ctx) {
  const s = staffSupport(ctx.api);
  void s
    .tickets()
    .then((data) => {
      view.list(
        'tickets',
        itemsOf(data).map((ticket) => ({
          path: `/support/staff/tickets/${encodeURIComponent(ticket.id)}`,
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
      const reload = () => ctx.navigate(`/support/staff/tickets/${encodeURIComponent(ticket.id)}`);
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
          path: `/support/staff/kb/${encodeURIComponent(article.id)}`,
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
    ctx.navigate(`/support/staff/kb/${encodeURIComponent(article.id)}`);
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
            .then(() => ctx.navigate(`/support/staff/kb/${encodeURIComponent(params.id)}`))
            .catch(() => row.append(view.problem()));
        });
      });
    })
    .catch(() => view.state('revisions', 'error'));
}

function adminList(view, ctx, loader, toRow) {
  void loader(admin(ctx.api))
    .then((data) => {
      const items = data?.items ?? data ?? [];
      view.list('rows', Array.isArray(items) ? items.map(toRow) : []);
    })
    .catch(() => view.state('rows', 'error'));
}

function pageAdminUsers(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.users(),
    (user) => ({ username: user.username ?? user.id, email: user.email ?? '' }),
  );
}

function pageAdminRoles(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.roles(),
    (role) => ({ name: role.name ?? role.id }),
  );
}

function pageAdminAudit(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.audit(),
    (entry) => ({ at: entry.at ?? '', action: entry.action ?? '', actor: entry.actor ?? '' }),
  );
}

function pageAdminWebhooks(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.webhooks(),
    (hook) => ({ url: hook.url ?? hook.id, events: (hook.events ?? []).join(', ') }),
  );
}

function pageAdminFilter(view, t, ctx) {
  const a = admin(ctx.api);
  const sections = [
    ['blocks', () => a.filterBlocks()],
    ['allowlist', () => a.filterAllowlist()],
    ['blocklist', () => a.filterBlocklist()],
  ];
  for (const [slot, loader] of sections) {
    void loader()
      .then((data) => {
        view.list(
          slot,
          itemsOf(data).map((row) => ({ label: row.word ?? row.pattern ?? JSON.stringify(row) })),
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
    (row) => ({ kind: row.kind ?? '', target: row.target ?? '' }),
  );
}

function pageAdminCsea(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.cseaCases(),
    (row) => ({ opened_at: row.opened_at ?? '', status: row.status ?? '' }),
  );
}

function pageAdminOauth(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.oauthClients(),
    (row) => ({ name: row.name ?? row.client_id, status: row.status ?? '' }),
  );
}

function pageAdminGames(view, t, ctx) {
  adminList(
    view,
    ctx,
    (a) => a.gamesCatalog(),
    (row) => ({ title: row.title ?? row.id }),
  );
}

function pageAdminHealth(view, t, ctx) {
  void admin(ctx.api)
    .health()
    .then((data) => {
      view.list('services', data?.services ?? []);
    })
    .catch(() => view.state('services', 'error'));
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
  support: { path: '/support', requires: { support: true } },
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
  'support-staff': { path: '/support/staff', requires: { support: true, admin: true } },
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
