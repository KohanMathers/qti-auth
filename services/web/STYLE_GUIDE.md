# QTI Auth Web Style Guide

This guide is prescriptive. If twelve agents each rebuild a different group of pages (auth, account, family, developer, games, admin-users, admin-safety, admin-oauth, admin-games, support-user, support-kb, support-staff, legal), following it will produce one visually consistent product.

Scope: the server-rendered web UI at `services/web/`. Pages are plain HTML templates in `src/assets/pages/*.html` wired up by the client runtime via `data-slot`, `data-show`, `data-form`, `data-state`, `data-action`, `data-field`, `data-bind-href`, `data-bind-value`, `data-item`, `data-message`, `data-part`, `data-link`, `data-t`. Those attributes are load-bearing and must be preserved exactly. The style guide adds visual polish on top; it does not change the wiring contract.

All CSS lives in a single bundled stylesheet served alongside `theme.css` (the config-driven palette). Do not add inline styles. Do not introduce a CSS framework. Do not add web fonts.

---

## 1. Design tokens

Tokens are CSS custom properties. There are three groups:

- **Branding tokens** (prefixed `--qt-color-*`, `--qt-bg-*`): generated server-side by `theme.ts` from the config's `branding.colors` and `branding.backgrounds`. Agents must consume them, never redeclare them.
- **Scale tokens** (spacing, radius, shadow, type, motion): declared once in the main stylesheet at `:root`. Fixed; not driven by config.
- **Semantic tokens** (`--qt-surface`, `--qt-text`, `--qt-border`...): computed from the branding tokens; swapped by `[data-theme="dark"]`.

### 1.1 Branding tokens (from config)

The orchestrator extends `branding.colors` to the full QTI palette and `branding.backgrounds` to the two auth images. `theme.ts` emits:

```css
:root {
  --qt-color-primary:      #5BB1EF;
  --qt-color-accent:       #BC6DE0;
  --qt-color-success:      #80D35D;
  --qt-color-warning:      #F7DA47;
  --qt-color-danger:       #DD5F5F;
  --qt-color-text:         #222034;
  --qt-color-text-muted:   #666577;
  --qt-color-bg:           #ffffff;
  --qt-color-bg-secondary: #f5f5f7;
  --qt-color-border:       #d1d1d6;
  --qt-color-gradient-from:#5BB1EF;
  --qt-color-gradient-to:  #BC6DE0;
  --qt-bg-auth-light:      url('...');
  --qt-bg-auth-dark:       url('...');
}
```

Agents never write a hex literal. They always consume these as `var(--qt-color-primary)` etc.

### 1.2 Scale tokens (fixed, main stylesheet)

```css
:root {
  --qt-space-xs:  0.25rem;
  --qt-space-sm:  0.5rem;
  --qt-space-md:  1rem;
  --qt-space-lg:  1.5rem;
  --qt-space-xl:  2rem;
  --qt-space-2xl: 3rem;
  --qt-space-3xl: 4rem;

  --qt-radius-sm:   4px;
  --qt-radius-md:   8px;
  --qt-radius-lg:   16px;
  --qt-radius-full: 9999px;

  --qt-shadow-sm: 0 1px 2px rgba(34, 32, 52, 0.06);
  --qt-shadow-md: 0 4px 16px rgba(34, 32, 52, 0.10);
  --qt-shadow-lg: 0 8px 32px rgba(34, 32, 52, 0.15);

  --qt-font-size-xs:   0.75rem;  --qt-line-xs:   1rem;
  --qt-font-size-sm:   0.875rem; --qt-line-sm:   1.25rem;
  --qt-font-size-base: 1rem;     --qt-line-base: 1.5rem;
  --qt-font-size-lg:   1.125rem; --qt-line-lg:   1.75rem;
  --qt-font-size-xl:   1.25rem;  --qt-line-xl:   1.75rem;
  --qt-font-size-2xl:  1.5rem;   --qt-line-2xl:  2rem;
  --qt-font-size-3xl:  2rem;     --qt-line-3xl:  2.5rem;

  --qt-weight-normal: 400;
  --qt-weight-medium: 500;
  --qt-weight-semibold: 600;
  --qt-weight-bold: 700;

  --qt-duration-fast:  120ms;
  --qt-duration-base:  180ms;
  --qt-duration-slow:  280ms;
  --qt-ease:           cubic-bezier(0.4, 0, 0.2, 1);

  --qt-focus-ring: 0 0 0 3px rgba(91, 177, 239, 0.45);

  --qt-z-nav:    10;
  --qt-z-toast:  40;
  --qt-z-dialog: 50;
}
```

Spacing scale: xs=4px, sm=8px, md=16px, lg=24px, xl=32px, 2xl=48px, 3xl=64px. All padding, margin, and gap values must use this scale.

### 1.3 Semantic tokens (light and dark pair)

Agents consume these for surface colour; never reach for the raw brand tokens inside a component.

```css
:root {
  --qt-surface:         var(--qt-color-bg);
  --qt-surface-sunken:  var(--qt-color-bg-secondary);
  --qt-surface-raised:  var(--qt-color-bg);
  --qt-text:            var(--qt-color-text);
  --qt-text-muted:      var(--qt-color-text-muted);
  --qt-border:          var(--qt-color-border);
  --qt-link:            var(--qt-color-primary);
  --qt-overlay:         rgba(34, 32, 52, 0.55);
}

[data-theme="dark"] {
  --qt-color-text:         #f5f5f7;
  --qt-color-text-muted:   #b0b0b8;
  --qt-color-bg:           #222034;
  --qt-color-bg-secondary: #2d2b3e;
  --qt-color-border:       #3d3b4f;
  --qt-shadow-sm:          0 1px 2px rgba(0, 0, 0, 0.3);
  --qt-shadow-md:          0 4px 16px rgba(0, 0, 0, 0.3);
  --qt-shadow-lg:          0 8px 32px rgba(0, 0, 0, 0.4);
  --qt-overlay:            rgba(0, 0, 0, 0.65);
  --qt-focus-ring:         0 0 0 3px rgba(91, 177, 239, 0.6);
}
```

---

## 2. Typography

### 2.1 Font stack

System fonts only. No `@font-face`, no CDN.

```css
body {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu,
    Cantarell, 'Helvetica Neue', Arial, sans-serif;
  font-size: var(--qt-font-size-base);
  line-height: var(--qt-line-base);
  color: var(--qt-text);
  background: var(--qt-surface-sunken);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code, pre, kbd, samp {
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
    'Liberation Mono', monospace;
}
```

### 2.2 Heading scale

```css
h1 { font-size: var(--qt-font-size-3xl); line-height: var(--qt-line-3xl); font-weight: var(--qt-weight-bold);     letter-spacing: -0.01em; }
h2 { font-size: var(--qt-font-size-2xl); line-height: var(--qt-line-2xl); font-weight: var(--qt-weight-semibold); letter-spacing: -0.005em; }
h3 { font-size: var(--qt-font-size-xl);  line-height: var(--qt-line-xl);  font-weight: var(--qt-weight-semibold); }
h4 { font-size: var(--qt-font-size-lg);  line-height: var(--qt-line-lg);  font-weight: var(--qt-weight-semibold); }
h5 { font-size: var(--qt-font-size-base);line-height: var(--qt-line-base);font-weight: var(--qt-weight-semibold); }
h6 { font-size: var(--qt-font-size-sm);  line-height: var(--qt-line-sm);  font-weight: var(--qt-weight-semibold); text-transform: uppercase; letter-spacing: 0.04em; color: var(--qt-text-muted); }

h1, h2, h3, h4, h5, h6 { margin: 0 0 var(--qt-space-md); }
p, ul, ol { margin: 0 0 var(--qt-space-md); }
```

Each page template begins with `<h2>` because the shell injects the outer frame; agents keep `<h2>` as the top-of-page heading inside page bodies. There is at most one `<h1>` per rendered document.

### 2.3 Links

```css
a, [data-link] {
  color: var(--qt-link);
  text-decoration: none;
  font-weight: var(--qt-weight-medium);
  transition: color var(--qt-duration-fast) var(--qt-ease);
}
a:hover, [data-link]:hover { text-decoration: underline; }
a:focus-visible, [data-link]:focus-visible {
  outline: none;
  box-shadow: var(--qt-focus-ring);
  border-radius: var(--qt-radius-sm);
}
```

### 2.4 Measure

- Body text max line length: 70ch. Apply via `.qt-prose { max-width: 70ch; }`.
- Reading surfaces (KB articles, legal) use 72ch and `font-size: var(--qt-font-size-lg)`.
- Form cards use their card width, not a prose cap.

---

## 3. Layout patterns

Each shell is a top-level `div` inside the server shell's `<main id="qtiauth-main">`. The client runtime renders page HTML into `<main>`; agents may wrap that content in a shell `div` through the per-surface layout.

### 3.1 `qt-auth-shell` - full-bleed centred card

Used by: sign-in, sign-up, forgot, reset, magic-link, verify, consent, confirm-email, revert-email, social-callback, device, waiting, guardian-approve, guardian-decline, support-guest, support-guest-verify.

```html
<div class="qt-auth-shell">
  <button class="qt-theme-toggle" type="button" data-action="toggle-theme" aria-label="Toggle theme"></button>
  <div class="qt-auth-card" role="region" aria-labelledby="qt-auth-title">
    <header class="qt-auth-card__header">
      <a class="qt-brand" href="/" data-link>
        <span class="qt-brand__name" data-field="product_name"></span>
      </a>
    </header>
    <div class="qt-auth-card__body"></div>
    <footer class="qt-auth-card__footer qt-prose">
      <p class="qt-text-muted"><small>(c) <span data-field="company_name"></span></small></p>
    </footer>
  </div>
</div>
```

```css
.qt-auth-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--qt-space-xl) var(--qt-space-md);
  background-image: var(--qt-bg-auth-light);
  background-size: cover;
  background-position: center;
  background-attachment: fixed;
  position: relative;
}
[data-theme="dark"] .qt-auth-shell { background-image: var(--qt-bg-auth-dark); }

.qt-auth-card {
  width: 100%;
  max-width: 480px;
  background: color-mix(in oklab, var(--qt-surface) 92%, transparent);
  border: 1px solid color-mix(in oklab, var(--qt-border) 60%, transparent);
  border-radius: var(--qt-radius-lg);
  box-shadow: var(--qt-shadow-lg);
  padding: var(--qt-space-2xl);
  backdrop-filter: blur(8px);
}

.qt-auth-card__header { margin-bottom: var(--qt-space-xl); text-align: center; }
.qt-auth-card__footer { margin-top: var(--qt-space-xl); text-align: center; }
```

### 3.2 `qt-app-shell` - top nav plus optional sidebar plus main

Used by: account, profile, email, security, sessions, methods, notifications, data, legal (account view), apps, developer, games, achievements, leaderboards, stats, redeem, child, family, family-invite, family-leave, family-session, devices, support (end-user hub), support-tickets, support-ticket, support-tickets-new, support-kb (list only), support-appeal.

```html
<div class="qt-app-shell">
  <header class="qt-app-nav" role="banner">
    <div class="qt-app-nav__inner qt-container">
      <a class="qt-brand" href="/" data-link><span data-field="product_name"></span></a>
      <nav class="qt-app-nav__links" aria-label="Primary">
        <a href="/account" data-link>Account</a>
        <a href="/support" data-link>Support</a>
      </nav>
      <div class="qt-app-nav__user">
        <button class="qt-theme-toggle" type="button" data-action="toggle-theme" aria-label="Toggle theme"></button>
      </div>
    </div>
  </header>
  <div class="qt-app-body qt-container">
    <aside class="qt-app-sidebar" aria-label="Section"></aside>
    <section class="qt-app-main qt-card"></section>
  </div>
</div>
```

```css
.qt-container { max-width: 1200px; margin-inline: auto; padding-inline: var(--qt-space-lg); }

.qt-app-shell  { min-height: 100vh; background: var(--qt-surface-sunken); }
.qt-app-nav    { background: var(--qt-surface); border-bottom: 1px solid var(--qt-border); position: sticky; top: 0; z-index: var(--qt-z-nav); }
.qt-app-nav__inner { display: flex; align-items: center; justify-content: space-between; gap: var(--qt-space-lg); min-height: 64px; }
.qt-app-nav__links { display: flex; gap: var(--qt-space-lg); }

.qt-app-body { display: grid; grid-template-columns: 220px 1fr; gap: var(--qt-space-xl); padding-block: var(--qt-space-xl); }
.qt-app-body:not(:has(.qt-app-sidebar)) { grid-template-columns: 1fr; }
@media (max-width: 720px) { .qt-app-body { grid-template-columns: 1fr; } }

.qt-app-main   { padding: var(--qt-space-xl); }
```

### 3.3 `qt-admin-shell` - sidebar-dominant

Used by: admin, admin-users, admin-user, admin-roles, admin-appeals, admin-audit, admin-moderation, admin-report, admin-csea, admin-csea-case, admin-filter, admin-entitlement, admin-games, admin-oauth, admin-oauth-client, admin-webhooks, admin-webhook, admin-health. Also for support-staff pages (support-staff, support-staff-tickets, support-staff-ticket, support-staff-kb, support-staff-kb-article, support-staff-macros, support-staff-metrics).

```html
<div class="qt-admin-shell">
  <aside class="qt-admin-sidebar" aria-label="Admin">
    <a class="qt-brand qt-brand--compact" href="/admin" data-link>
      <span data-field="product_name"></span>
    </a>
    <nav class="qt-nav-list" aria-label="Admin sections">
      <a href="/admin/users"      data-link>Users</a>
      <a href="/admin/moderation" data-link>Moderation</a>
    </nav>
  </aside>
  <div class="qt-admin-content">
    <header class="qt-admin-topbar">
      <nav class="qt-breadcrumb" aria-label="Breadcrumb"></nav>
      <div class="qt-admin-topbar__actions">
        <button class="qt-theme-toggle" type="button" data-action="toggle-theme"></button>
      </div>
    </header>
    <main class="qt-admin-main"></main>
  </div>
</div>
```

```css
.qt-admin-shell { min-height: 100vh; display: grid; grid-template-columns: 260px 1fr; background: var(--qt-surface-sunken); }
@media (max-width: 900px) { .qt-admin-shell { grid-template-columns: 1fr; } }

.qt-admin-sidebar { background: var(--qt-surface); border-right: 1px solid var(--qt-border); padding: var(--qt-space-lg); display: flex; flex-direction: column; gap: var(--qt-space-lg); position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.qt-admin-content { display: flex; flex-direction: column; min-width: 0; }
.qt-admin-topbar  { display: flex; align-items: center; justify-content: space-between; padding: var(--qt-space-md) var(--qt-space-xl); background: var(--qt-surface); border-bottom: 1px solid var(--qt-border); }
.qt-admin-main    { padding: var(--qt-space-xl); flex: 1; }
```

### 3.4 `qt-kb-shell` - reading-first

Used by: support-kb-article, support-kb-category, support-kb-search, legal-document.

```html
<div class="qt-kb-shell">
  <header class="qt-kb-topbar qt-container">
    <a class="qt-brand" href="/support" data-link><span data-field="product_name"></span> Help</a>
    <form class="qt-kb-search" data-form="kb-search" novalidate>
      <input type="search" name="q" placeholder="Search help" aria-label="Search help" />
    </form>
  </header>
  <article class="qt-kb-article qt-prose"></article>
</div>
```

```css
.qt-kb-shell   { min-height: 100vh; background: var(--qt-surface); }
.qt-kb-topbar  { display: flex; align-items: center; gap: var(--qt-space-lg); padding-block: var(--qt-space-lg); border-bottom: 1px solid var(--qt-border); }
.qt-kb-article { max-width: 72ch; margin: var(--qt-space-2xl) auto; padding-inline: var(--qt-space-lg); font-size: var(--qt-font-size-lg); line-height: 1.7; }
.qt-kb-article h2 { margin-top: var(--qt-space-xl); }
.qt-kb-article h3 { margin-top: var(--qt-space-lg); }
.qt-kb-article pre { margin-block: var(--qt-space-lg); }
```

---

## 4. Components

Each component is a (spec, HTML, CSS) triple. All CSS belongs in the one bundled stylesheet. Variants are expressed through `data-variant`, sizes through `data-size`, and transient states through `data-state`.

### 4.1 Button

Variants: `primary` (default), `secondary`, `ghost`, `danger`. Sizes: `sm`, `md` (default), `lg`. States: default, hover, focus, active, disabled, loading. Buttons never span full-width unless placed inside a `.qt-actions--block` wrapper.

```html
<button type="button" class="qt-button" data-variant="primary" data-size="md">Save</button>

<button type="submit" class="qt-button" data-variant="primary" data-state="loading" aria-busy="true" disabled>
  <span class="qt-spinner" aria-hidden="true"></span>
  <span>Signing in</span>
</button>
```

```css
.qt-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--qt-space-sm);
  padding: var(--qt-space-sm) var(--qt-space-lg);
  border: 1px solid transparent;
  border-radius: var(--qt-radius-md);
  font-size: var(--qt-font-size-base);
  font-weight: var(--qt-weight-semibold);
  line-height: 1;
  cursor: pointer;
  user-select: none;
  transition:
    background-color var(--qt-duration-fast) var(--qt-ease),
    border-color     var(--qt-duration-fast) var(--qt-ease),
    color            var(--qt-duration-fast) var(--qt-ease),
    box-shadow       var(--qt-duration-fast) var(--qt-ease);
}
.qt-button:focus-visible { outline: none; box-shadow: var(--qt-focus-ring); }
.qt-button:disabled, .qt-button[aria-busy="true"] { opacity: 0.6; cursor: not-allowed; }

.qt-button[data-size="sm"] { padding: var(--qt-space-xs) var(--qt-space-md); font-size: var(--qt-font-size-sm); }
.qt-button[data-size="lg"] { padding: var(--qt-space-md) var(--qt-space-xl); font-size: var(--qt-font-size-lg); }

.qt-button[data-variant="primary"]   { background: var(--qt-color-primary); color: #fff; }
.qt-button[data-variant="primary"]:hover:not(:disabled) { background: color-mix(in oklab, var(--qt-color-primary) 85%, black); }

.qt-button[data-variant="secondary"] { background: var(--qt-surface-sunken); color: var(--qt-text); border-color: var(--qt-border); }
.qt-button[data-variant="secondary"]:hover:not(:disabled) { background: var(--qt-border); }

.qt-button[data-variant="ghost"]     { background: transparent; color: var(--qt-text); }
.qt-button[data-variant="ghost"]:hover:not(:disabled) { background: var(--qt-surface-sunken); }

.qt-button[data-variant="danger"]    { background: var(--qt-color-danger); color: #fff; }
.qt-button[data-variant="danger"]:hover:not(:disabled) { background: color-mix(in oklab, var(--qt-color-danger) 85%, black); }
```

Existing templates emit `<button type="submit">` without a class. The bare `<button>` must look identical to `.qt-button[data-variant="primary"]`. Legacy classes `qtiauth-button`, `qtiauth-button-ghost`, `qtiauth-button-danger`, `qtiauth-button-social` are aliased to the matching `.qt-button` variants and remain in the HTML.

### 4.2 Input

Covers `text`, `email`, `password`, `search`, `tel`, `url`, `number`, and `textarea`. Error state via `aria-invalid="true"`. Help text uses `aria-describedby`. Required state uses the native `required` attribute plus a visual asterisk in the label.

```html
<p class="qt-field">
  <label for="qt-f-email" class="qt-label">
    Email
    <span class="qt-required" aria-hidden="true">*</span>
  </label>
  <input id="qt-f-email" class="qt-input" type="email" name="email"
         autocomplete="email" required aria-describedby="qt-f-email-help" />
  <small id="qt-f-email-help" class="qt-help">We only use this to contact you.</small>
</p>
```

```css
.qt-field    { display: block; margin-bottom: var(--qt-space-lg); }
.qt-label    { display: block; font-size: var(--qt-font-size-sm); font-weight: var(--qt-weight-medium); margin-bottom: var(--qt-space-sm); color: var(--qt-text); }
.qt-required { color: var(--qt-color-danger); margin-left: 2px; }
.qt-help     { display: block; margin-top: var(--qt-space-xs); font-size: var(--qt-font-size-sm); color: var(--qt-text-muted); }

.qt-input, .qt-textarea, .qt-select {
  width: 100%;
  padding: var(--qt-space-sm) var(--qt-space-md);
  font-size: var(--qt-font-size-base);
  color: var(--qt-text);
  background: var(--qt-surface);
  border: 1px solid var(--qt-border);
  border-radius: var(--qt-radius-md);
  transition: border-color var(--qt-duration-fast) var(--qt-ease), box-shadow var(--qt-duration-fast) var(--qt-ease);
}
.qt-textarea { min-height: 7rem; resize: vertical; }
.qt-input:focus-visible, .qt-textarea:focus-visible, .qt-select:focus-visible {
  outline: none;
  border-color: var(--qt-color-primary);
  box-shadow: var(--qt-focus-ring);
}
.qt-input[aria-invalid="true"], .qt-textarea[aria-invalid="true"], .qt-select[aria-invalid="true"] {
  border-color: var(--qt-color-danger);
  box-shadow: 0 0 0 3px rgba(221, 95, 95, 0.25);
}
.qt-input:disabled { background: var(--qt-surface-sunken); color: var(--qt-text-muted); cursor: not-allowed; }
```

Template-emitted `.qtiauth-field` is aliased: its `label` picks up `.qt-label` rules and its `input|textarea|select` pick up the `.qt-input` rules.

### 4.3 Select

```html
<p class="qt-field">
  <label class="qt-label" for="qt-f-locale">Language</label>
  <select id="qt-f-locale" class="qt-select" name="locale">
    <option value="en-GB">English (UK)</option>
    <option value="en-US">English (US)</option>
  </select>
</p>
```

```css
.qt-select {
  appearance: none;
  background-image: linear-gradient(45deg, transparent 50%, var(--qt-text-muted) 50%),
                    linear-gradient(135deg, var(--qt-text-muted) 50%, transparent 50%);
  background-position: calc(100% - 18px) 50%, calc(100% - 12px) 50%;
  background-size: 6px 6px, 6px 6px;
  background-repeat: no-repeat;
  padding-right: var(--qt-space-2xl);
}
```

### 4.4 Checkbox and radio

```html
<label class="qt-check">
  <input type="checkbox" name="agree" required />
  <span>I agree to the <a href="/legal" data-link>terms</a>.</span>
</label>

<fieldset class="qt-fieldset">
  <legend class="qt-label">Visibility</legend>
  <label class="qt-check"><input type="radio" name="vis" value="public"  /><span>Public</span></label>
  <label class="qt-check"><input type="radio" name="vis" value="private" /><span>Private</span></label>
</fieldset>
```

```css
.qt-check         { display: flex; align-items: center; gap: var(--qt-space-sm); font-size: var(--qt-font-size-base); line-height: var(--qt-line-base); cursor: pointer; margin-bottom: var(--qt-space-sm); }
.qt-check input   { width: 1.125rem; height: 1.125rem; accent-color: var(--qt-color-primary); flex-shrink: 0; cursor: pointer; }
.qt-check input:focus-visible { outline: none; box-shadow: var(--qt-focus-ring); border-radius: var(--qt-radius-sm); }
.qt-fieldset      { border: 1px solid var(--qt-border); border-radius: var(--qt-radius-md); padding: var(--qt-space-md) var(--qt-space-lg); margin-bottom: var(--qt-space-lg); }
.qt-fieldset legend { padding-inline: var(--qt-space-sm); }
```

### 4.5 Form group and actions

```html
<form data-form="password" class="qt-form" novalidate>
  <p class="qt-field"></p>
  <p class="qt-field"></p>
  <div class="qt-actions">
    <button type="submit" class="qt-button" data-variant="primary">Sign in</button>
    <a class="qt-button" data-variant="ghost" href="/forgot" data-link>Forgot password</a>
  </div>
</form>
```

```css
.qt-form           { display: flex; flex-direction: column; }
.qt-actions        { display: flex; align-items: center; gap: var(--qt-space-md); margin-top: var(--qt-space-md); flex-wrap: wrap; }
.qt-actions--block { display: flex; }
.qt-actions--block .qt-button { flex: 1 1 auto; }
```

Legacy `.qtiauth-actions` is a straight alias of `.qt-actions`.

### 4.6 Card

```html
<article class="qt-card">
  <header class="qt-card__header">
    <h3>Recovery codes</h3>
    <p class="qt-text-muted">Save these somewhere safe.</p>
  </header>
  <div class="qt-card__body"></div>
  <footer class="qt-card__footer">
    <button class="qt-button" data-variant="secondary">Regenerate</button>
  </footer>
</article>
```

```css
.qt-card           { background: var(--qt-surface); border: 1px solid var(--qt-border); border-radius: var(--qt-radius-md); box-shadow: var(--qt-shadow-sm); overflow: hidden; }
.qt-card__header   { padding: var(--qt-space-lg) var(--qt-space-xl); border-bottom: 1px solid var(--qt-border); }
.qt-card__body     { padding: var(--qt-space-xl); }
.qt-card__footer   { padding: var(--qt-space-md) var(--qt-space-xl); border-top: 1px solid var(--qt-border); background: var(--qt-surface-sunken); display: flex; justify-content: flex-end; gap: var(--qt-space-sm); }
.qt-card--plain    { box-shadow: none; }
```

### 4.7 Nav

Top bar is defined in section 3.2. Sidebar list, breadcrumb and user menu:

```html
<nav class="qt-nav-list" aria-label="Settings">
  <a href="/account/profile" data-link data-current="page">Profile</a>
  <a href="/account/email"   data-link>Email</a>
  <a href="/account/security"data-link>Security</a>
</nav>

<nav class="qt-breadcrumb" aria-label="Breadcrumb">
  <ol>
    <li><a href="/admin" data-link>Admin</a></li>
    <li><a href="/admin/users" data-link>Users</a></li>
    <li aria-current="page">Jane Doe</li>
  </ol>
</nav>

<details class="qt-user-menu">
  <summary><span class="qt-avatar" data-field="initials"></span><span data-field="username"></span></summary>
  <ul>
    <li><a href="/account" data-link>Account</a></li>
    <li><button type="button" data-action="sign-out">Sign out</button></li>
  </ul>
</details>
```

```css
.qt-nav-list        { display: flex; flex-direction: column; gap: var(--qt-space-xs); }
.qt-nav-list > a    { display: block; padding: var(--qt-space-sm) var(--qt-space-md); border-radius: var(--qt-radius-md); color: var(--qt-text); font-weight: var(--qt-weight-medium); text-decoration: none; transition: background-color var(--qt-duration-fast) var(--qt-ease); }
.qt-nav-list > a:hover                 { background: var(--qt-surface-sunken); }
.qt-nav-list > a[data-current="page"]  { background: var(--qt-color-primary); color: #fff; }
.qt-nav-list > a[data-current="page"]:hover { background: color-mix(in oklab, var(--qt-color-primary) 85%, black); }

.qt-breadcrumb ol              { list-style: none; display: flex; flex-wrap: wrap; gap: var(--qt-space-xs); font-size: var(--qt-font-size-sm); color: var(--qt-text-muted); padding: 0; margin: 0; }
.qt-breadcrumb li + li::before { content: "/"; margin-right: var(--qt-space-xs); color: var(--qt-border); }
.qt-breadcrumb [aria-current="page"] { color: var(--qt-text); font-weight: var(--qt-weight-medium); }

.qt-user-menu           { position: relative; }
.qt-user-menu summary   { list-style: none; display: inline-flex; align-items: center; gap: var(--qt-space-sm); cursor: pointer; padding: var(--qt-space-xs) var(--qt-space-sm); border-radius: var(--qt-radius-md); }
.qt-user-menu summary::-webkit-details-marker { display: none; }
.qt-user-menu[open] > ul { position: absolute; right: 0; top: calc(100% + var(--qt-space-xs)); min-width: 180px; background: var(--qt-surface); border: 1px solid var(--qt-border); border-radius: var(--qt-radius-md); box-shadow: var(--qt-shadow-md); padding: var(--qt-space-xs); list-style: none; margin: 0; z-index: var(--qt-z-nav); }
.qt-user-menu li a, .qt-user-menu li button { display: block; width: 100%; text-align: left; padding: var(--qt-space-sm) var(--qt-space-md); border-radius: var(--qt-radius-sm); color: var(--qt-text); background: none; border: none; font: inherit; cursor: pointer; }
.qt-user-menu li a:hover, .qt-user-menu li button:hover { background: var(--qt-surface-sunken); }
```

### 4.8 Toast and inline message

Two variants exist. The static server-rendered one is printed as part of the page. The live-region variant is updated by the runtime and uses `role="status"` or `role="alert"`.

```html
<p class="qt-message" data-variant="info"    role="status">Here is some info.</p>
<p class="qt-message" data-variant="success" role="status">Saved.</p>
<p class="qt-message" data-variant="warning" role="status">This is irreversible.</p>
<p class="qt-message" data-variant="danger"  role="alert">Something went wrong.</p>
```

```css
.qt-message {
  display: flex;
  align-items: flex-start;
  gap: var(--qt-space-sm);
  padding: var(--qt-space-md) var(--qt-space-lg);
  border-radius: var(--qt-radius-md);
  border: 1px solid var(--qt-border);
  background: var(--qt-surface-sunken);
  color: var(--qt-text);
  font-size: var(--qt-font-size-sm);
  line-height: var(--qt-line-sm);
  margin-bottom: var(--qt-space-md);
}
.qt-message[data-variant="info"]    { border-color: color-mix(in oklab, var(--qt-color-primary) 40%, var(--qt-border)); background: color-mix(in oklab, var(--qt-color-primary) 10%, var(--qt-surface)); }
.qt-message[data-variant="success"] { border-color: color-mix(in oklab, var(--qt-color-success) 40%, var(--qt-border)); background: color-mix(in oklab, var(--qt-color-success) 10%, var(--qt-surface)); }
.qt-message[data-variant="warning"] { border-color: color-mix(in oklab, var(--qt-color-warning) 50%, var(--qt-border)); background: color-mix(in oklab, var(--qt-color-warning) 12%, var(--qt-surface)); }
.qt-message[data-variant="danger"]  { border-color: color-mix(in oklab, var(--qt-color-danger)  40%, var(--qt-border)); background: color-mix(in oklab, var(--qt-color-danger)  10%, var(--qt-surface)); }

.qtiauth-success  { /* alias of .qt-message[data-variant="success"] */ }
.qtiauth-alert    { /* alias of .qt-message[data-variant="warning"] */ }
.qtiauth-feedback { /* alias of .qt-message, applied only when non-empty */ }
.qtiauth-feedback:empty { display: none; }
.qtiauth-lede     { color: var(--qt-text-muted); font-size: var(--qt-font-size-lg); margin-bottom: var(--qt-space-lg); }
.qtiauth-muted    { color: var(--qt-text-muted); font-size: var(--qt-font-size-sm); }
.qtiauth-empty    { color: var(--qt-text-muted); padding: var(--qt-space-xl); text-align: center; }
.qtiauth-status   { font-size: var(--qt-font-size-sm); color: var(--qt-text-muted); margin-block: var(--qt-space-sm); }
```

### 4.9 Dialog and modal

Use the native `<dialog>` element, opened with `.showModal()`. The browser handles focus trap.

```html
<dialog class="qt-dialog" data-slot="confirm">
  <form method="dialog" class="qt-dialog__inner">
    <header class="qt-dialog__header"><h3>Remove this device?</h3></header>
    <div class="qt-dialog__body"><p>You will be signed out of it immediately.</p></div>
    <footer class="qt-dialog__footer">
      <button class="qt-button" data-variant="ghost"  value="cancel">Cancel</button>
      <button class="qt-button" data-variant="danger" value="confirm">Remove</button>
    </footer>
  </form>
</dialog>
```

```css
.qt-dialog           { padding: 0; border: none; border-radius: var(--qt-radius-lg); background: var(--qt-surface); color: var(--qt-text); max-width: 480px; width: calc(100% - 2 * var(--qt-space-md)); box-shadow: var(--qt-shadow-lg); }
.qt-dialog::backdrop { background: var(--qt-overlay); }
.qt-dialog__header   { padding: var(--qt-space-lg) var(--qt-space-xl); border-bottom: 1px solid var(--qt-border); }
.qt-dialog__body     { padding: var(--qt-space-xl); }
.qt-dialog__footer   { padding: var(--qt-space-md) var(--qt-space-xl); border-top: 1px solid var(--qt-border); display: flex; justify-content: flex-end; gap: var(--qt-space-sm); background: var(--qt-surface-sunken); }
```

### 4.10 Badge, tag, pill

```html
<span class="qt-badge" data-variant="success">Verified</span>
<span class="qt-badge" data-variant="warning">Pending</span>
<span class="qt-badge" data-variant="danger">Blocked</span>
<span class="qt-badge" data-variant="info">Beta</span>
<span class="qt-badge" data-variant="neutral">Draft</span>
```

```css
.qt-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--qt-space-sm);
  border-radius: var(--qt-radius-full);
  font-size: var(--qt-font-size-xs);
  font-weight: var(--qt-weight-semibold);
  line-height: 1.4;
  letter-spacing: 0.01em;
  border: 1px solid transparent;
}
.qt-badge[data-variant="neutral"] { background: var(--qt-surface-sunken); color: var(--qt-text-muted); border-color: var(--qt-border); }
.qt-badge[data-variant="info"]    { background: color-mix(in oklab, var(--qt-color-primary) 18%, var(--qt-surface)); color: var(--qt-color-primary); }
.qt-badge[data-variant="success"] { background: color-mix(in oklab, var(--qt-color-success) 20%, var(--qt-surface)); color: color-mix(in oklab, var(--qt-color-success) 70%, black); }
.qt-badge[data-variant="warning"] { background: color-mix(in oklab, var(--qt-color-warning) 25%, var(--qt-surface)); color: color-mix(in oklab, var(--qt-color-warning) 70%, black); }
.qt-badge[data-variant="danger"]  { background: color-mix(in oklab, var(--qt-color-danger)  18%, var(--qt-surface)); color: var(--qt-color-danger); }
```

### 4.11 Table

```html
<div class="qt-table-wrap">
  <table class="qt-table" data-variant="zebra" data-size="md">
    <thead>
      <tr><th scope="col">User</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col" class="qt-table__actions">Actions</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>Jane Doe</td>
        <td>jane@example.com</td>
        <td><span class="qt-badge" data-variant="info">Admin</span></td>
        <td class="qt-table__actions"><button class="qt-button" data-variant="ghost" data-size="sm">Edit</button></td>
      </tr>
    </tbody>
  </table>
  <p class="qt-empty" data-state="empty" hidden>No users to show.</p>
</div>
```

```css
.qt-table-wrap    { overflow-x: auto; border: 1px solid var(--qt-border); border-radius: var(--qt-radius-md); background: var(--qt-surface); }
.qt-table         { width: 100%; border-collapse: collapse; font-size: var(--qt-font-size-sm); }
.qt-table th, .qt-table td { padding: var(--qt-space-md) var(--qt-space-lg); text-align: left; border-bottom: 1px solid var(--qt-border); vertical-align: middle; }
.qt-table th      { font-weight: var(--qt-weight-semibold); color: var(--qt-text-muted); background: var(--qt-surface-sunken); text-transform: uppercase; letter-spacing: 0.04em; font-size: var(--qt-font-size-xs); }
.qt-table tbody tr:last-child td { border-bottom: none; }
.qt-table[data-variant="zebra"] tbody tr:nth-child(even) { background: var(--qt-surface-sunken); }
.qt-table[data-variant="hoverable"] tbody tr:hover { background: color-mix(in oklab, var(--qt-color-primary) 6%, var(--qt-surface)); }
.qt-table[data-size="sm"] th, .qt-table[data-size="sm"] td { padding: var(--qt-space-sm) var(--qt-space-md); }
.qt-table__actions { text-align: right; width: 1%; white-space: nowrap; }
```

### 4.12 Pagination

```html
<nav class="qt-pagination" aria-label="Pagination">
  <a class="qt-button" data-variant="ghost" data-size="sm" data-link href="?page=2" rel="prev">Previous</a>
  <ol>
    <li><a data-link href="?page=1">1</a></li>
    <li><a data-link href="?page=2" aria-current="page">2</a></li>
    <li><a data-link href="?page=3">3</a></li>
  </ol>
  <a class="qt-button" data-variant="ghost" data-size="sm" data-link href="?page=4" rel="next">Next</a>
</nav>
```

```css
.qt-pagination    { display: flex; align-items: center; gap: var(--qt-space-md); justify-content: center; margin-top: var(--qt-space-lg); }
.qt-pagination ol { list-style: none; display: flex; gap: var(--qt-space-xs); padding: 0; margin: 0; }
.qt-pagination li a { display: inline-flex; align-items: center; justify-content: center; min-width: 2rem; height: 2rem; padding-inline: var(--qt-space-sm); border-radius: var(--qt-radius-md); color: var(--qt-text); text-decoration: none; font-size: var(--qt-font-size-sm); }
.qt-pagination li a[aria-current="page"] { background: var(--qt-color-primary); color: #fff; font-weight: var(--qt-weight-semibold); }
.qt-pagination li a:hover:not([aria-current]) { background: var(--qt-surface-sunken); }
```

### 4.13 Avatar

```html
<span class="qt-avatar" data-size="md"><span data-field="initials">JD</span></span>
<span class="qt-avatar" data-size="lg"><img data-bind-src="avatar_url" alt="" /></span>
```

```css
.qt-avatar          { display: inline-flex; align-items: center; justify-content: center; width: 2rem; height: 2rem; border-radius: var(--qt-radius-full); background: color-mix(in oklab, var(--qt-color-accent) 30%, var(--qt-surface-sunken)); color: var(--qt-text); font-size: var(--qt-font-size-sm); font-weight: var(--qt-weight-semibold); overflow: hidden; flex-shrink: 0; }
.qt-avatar[data-size="sm"] { width: 1.5rem; height: 1.5rem; font-size: var(--qt-font-size-xs); }
.qt-avatar[data-size="lg"] { width: 3rem;   height: 3rem;   font-size: var(--qt-font-size-lg); }
.qt-avatar img      { width: 100%; height: 100%; object-fit: cover; }
```

### 4.14 Spinner

```html
<span class="qt-spinner" role="status" aria-label="Loading"></span>
```

```css
.qt-spinner      { display: inline-block; width: 1rem; height: 1rem; border: 2px solid var(--qt-border); border-top-color: var(--qt-color-primary); border-radius: 50%; animation: qt-spin 0.8s linear infinite; }
.qt-spinner[data-size="lg"] { width: 2.5rem; height: 2.5rem; border-width: 3px; }
@keyframes qt-spin { to { transform: rotate(360deg); } }
```

### 4.15 Empty state

```html
<div class="qt-empty-state" data-state="empty">
  <div class="qt-empty-state__icon" aria-hidden="true"></div>
  <h3 class="qt-empty-state__title">No tickets yet</h3>
  <p class="qt-empty-state__desc">Open a ticket and it will appear here.</p>
  <a class="qt-button" data-variant="primary" data-link href="/support/tickets/new">Open a ticket</a>
</div>
```

```css
.qt-empty-state          { display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--qt-space-md); padding: var(--qt-space-2xl) var(--qt-space-xl); color: var(--qt-text-muted); }
.qt-empty-state__icon    { width: 48px; height: 48px; display: grid; place-items: center; background: var(--qt-surface-sunken); border-radius: var(--qt-radius-full); color: var(--qt-text-muted); }
.qt-empty-state__title   { color: var(--qt-text); margin: 0; }
.qt-empty-state__desc    { max-width: 48ch; margin: 0; }
```

### 4.16 Code block

```html
<p>Set <code class="qt-code">QTIAUTH_LOCALE=en-GB</code> in your env.</p>

<pre class="qt-pre"><code>export QTIAUTH_LOCALE=en-GB</code></pre>

<ul class="qt-recovery-codes">
  <template data-item="codes"><li><code data-field="code"></code></li></template>
</ul>
```

```css
.qt-code, code  { background: var(--qt-surface-sunken); border: 1px solid var(--qt-border); border-radius: var(--qt-radius-sm); padding: 1px var(--qt-space-xs); font-size: 0.9em; color: var(--qt-text); }
.qt-pre         { background: var(--qt-surface-sunken); border: 1px solid var(--qt-border); border-radius: var(--qt-radius-md); padding: var(--qt-space-md) var(--qt-space-lg); overflow-x: auto; font-size: var(--qt-font-size-sm); line-height: 1.5; }
.qt-pre code    { background: none; border: none; padding: 0; }

.qt-recovery-codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--qt-space-sm);
  list-style: none;
  padding: 0;
  margin: var(--qt-space-md) 0;
}
.qt-recovery-codes li code { display: block; text-align: center; padding: var(--qt-space-sm); font-size: var(--qt-font-size-base); letter-spacing: 0.08em; }
@media (min-width: 480px) { .qt-recovery-codes { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
```

---

## 5. Dark mode

### 5.1 Strategy

1. Default: follow `prefers-color-scheme`. The main stylesheet contains:
   ```css
   @media (prefers-color-scheme: dark) {
     :root:not([data-theme="light"]) { /* dark semantic tokens */ }
   }
   ```
2. Manual override: `<html data-theme="light">` or `<html data-theme="dark">`. The attribute overrides the media query.
3. Persistence: cookie `qt_theme=light|dark|auto`, SameSite=Lax, 1 year. The server reads the cookie and emits the matching `data-theme` attribute on `<html>` so there is no FOUC. If the cookie is `auto` or missing, no attribute is set.
4. Toggle: a single `.qt-theme-toggle` button in each shell. Click order cycles `auto -> light -> dark -> auto`. The button fires a client action that updates both the cookie and the `data-theme` attribute on `<html>`.

### 5.2 Toggle

```html
<button class="qt-theme-toggle" type="button" data-action="toggle-theme"
        aria-label="Switch theme" aria-pressed="false">
  <svg class="qt-theme-toggle__sun"  aria-hidden="true" viewBox="0 0 24 24"></svg>
  <svg class="qt-theme-toggle__moon" aria-hidden="true" viewBox="0 0 24 24"></svg>
</button>
```

```css
.qt-theme-toggle           { width: 40px; height: 40px; display: grid; place-items: center; background: var(--qt-surface); border: 1px solid var(--qt-border); border-radius: var(--qt-radius-full); color: var(--qt-text); cursor: pointer; transition: background-color var(--qt-duration-fast) var(--qt-ease); }
.qt-theme-toggle:hover     { background: var(--qt-surface-sunken); }
.qt-theme-toggle:focus-visible { outline: none; box-shadow: var(--qt-focus-ring); }
.qt-theme-toggle__moon     { display: none; }
[data-theme="dark"] .qt-theme-toggle__sun  { display: none; }
[data-theme="dark"] .qt-theme-toggle__moon { display: inline; }

.qt-auth-shell .qt-theme-toggle { position: fixed; top: var(--qt-space-lg); right: var(--qt-space-lg); z-index: var(--qt-z-nav); box-shadow: var(--qt-shadow-md); }
```

### 5.3 Rules

- Never hardcode a dark colour; reference `--qt-*` tokens so the token-swap handles both themes.
- Images and illustrations must work on either theme. Prefer inline SVG with `currentColor`.
- `<meta name="color-scheme" content="light dark">` is already in the shell; do not touch.

---

## 6. Accessibility baseline

- **Focus ring.** Every interactive element gets `:focus-visible { box-shadow: var(--qt-focus-ring); }`. Never `outline: none` without replacing it.
- **Colour contrast.** All text at WCAG AA (4.5:1 for body, 3:1 for large and UI). The muted token (`#666577` on `#ffffff`) and its dark counterpart (`#b0b0b8` on `#222034`) meet AA for small text.
- **Semantic landmarks.** Every page has one `<main>` (provided by the shell). Shells add `<header role="banner">`, `<nav>` with `aria-label`, and `<aside>` where present. Admin pages also add `<nav aria-label="Breadcrumb">`.
- **Skip link.** The server shell already emits `<a class="qtiauth-skip-link" href="#qtiauth-main">`. Style:
  ```css
  .qtiauth-skip-link { position: absolute; left: var(--qt-space-md); top: var(--qt-space-md); background: var(--qt-color-primary); color: #fff; padding: var(--qt-space-sm) var(--qt-space-md); border-radius: var(--qt-radius-md); transform: translateY(-200%); transition: transform var(--qt-duration-fast) var(--qt-ease); z-index: var(--qt-z-dialog); }
  .qtiauth-skip-link:focus-visible { transform: translateY(0); }
  ```
- **Live regions.** The shell injects `<div id="qtiauth-live" role="status" aria-live="polite">`. In-page feedback uses `[data-part$="-feedback"]` with `aria-live="polite"`, or `role="alert"` for errors.
- **Keyboard-only.** All interactive controls reachable in source order. Dialogs are native `<dialog>` so the browser handles focus trap. `<details>` menus close on Escape and outside click.
- **Required and invalid state.** Always use `required` on native inputs, and set `aria-invalid="true"` when a validation error surfaces. Error messages are a `.qt-message[data-variant="danger"]` tied by `aria-describedby`.
- **Reduced motion.**
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
    .qt-spinner { animation: none; border-top-color: var(--qt-color-primary); }
  }
  ```
- **Visually hidden.** Use `.qt-visually-hidden`, not `display: none`, for text that must be exposed to assistive tech:
  ```css
  .qt-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  ```

---

## 7. Motion

Allowed:

- `background-color`, `border-color`, `color`, `box-shadow`, `transform` (translate or scale within 1.03), `opacity`, on durations between `--qt-duration-fast` and `--qt-duration-slow`.
- `qt-spin` keyframes on the spinner.
- The skip link translate-in on focus.

Forbidden:

- Bouncing or spring easings; keep to `--qt-ease`.
- Parallax or scroll-linked animation.
- Auto-playing video or GIFs.
- Any effect that moves content by more than 8px on hover.
- Animated gradients or animated backgrounds.
- Flash or fade on page load longer than 200ms.

All animation is guarded by the reduced-motion block in section 6.

---

## 8. Class naming

### 8.1 Prefix

Every project class is `qt-`-prefixed. Component root classes are the component name (`qt-button`, `qt-card`). Component parts use double-underscore (`qt-card__header`). Variants, sizes, and states are attributes on the root, not extra classes.

| Concern  | Mechanism                              | Example                                 |
| -------- | -------------------------------------- | --------------------------------------- |
| Variant  | `data-variant="..."`                   | `.qt-button[data-variant="primary"]`    |
| Size     | `data-size="sm\|md\|lg"`               | `.qt-button[data-size="sm"]`            |
| State    | `data-state="loading\|list\|empty"`    | `.qt-form[data-state="loading"]`        |
| Current  | `data-current="page"` / `aria-current` | `.qt-nav-list > a[data-current="page"]` |

Do not invent `.qt-button--primary`. Prefer attribute selectors so the same class can be toggled by the runtime without classlist churn.

### 8.2 Legacy `qtiauth-` prefix

Page templates ship with `qtiauth-` classes (`qtiauth-field`, `qtiauth-actions`, `qtiauth-success`, `qtiauth-alert`, `qtiauth-feedback`, `qtiauth-list`, `qtiauth-empty`, `qtiauth-lede`, `qtiauth-muted`, `qtiauth-button`, `qtiauth-button-ghost`, `qtiauth-button-danger`, `qtiauth-button-social`, `qtiauth-social`, `qtiauth-social-list`, `qtiauth-article`, `qtiauth-status`, `qtiauth-skip-link`). Keep them in the HTML (the templates are a contract with the runtime) and style them as aliases of the `qt-` components. Do not rename them in the HTML.

### 8.3 Utility classes (bounded set)

Only these utilities exist. Everything else is a component.

```css
.qt-stack        { display: flex; flex-direction: column; gap: var(--qt-space-md); }
.qt-stack--sm    { gap: var(--qt-space-sm); }
.qt-stack--lg    { gap: var(--qt-space-lg); }

.qt-cluster      { display: flex; flex-wrap: wrap; align-items: center; gap: var(--qt-space-sm); }

.qt-prose        { max-width: 70ch; }
.qt-prose p + p  { margin-top: var(--qt-space-md); }

.qt-text-muted   { color: var(--qt-text-muted); }
.qt-text-small   { font-size: var(--qt-font-size-sm); }
.qt-text-center  { text-align: center; }

.qt-visually-hidden { /* see section 6 */ }
```

Do not add `.mt-4`, `.p-6`, `.flex`, `.grid-cols-2`, etc. Compose with components and the shells.

---

## 9. Page patterns

### 9.1 Auth surface - sign-in (preserves `sign-in.html` wiring)

```html
<div class="qt-auth-shell">
  <button class="qt-theme-toggle" type="button" data-action="toggle-theme" aria-label="Toggle theme"></button>
  <section class="qt-auth-card" aria-labelledby="qt-signin-title">
    <header class="qt-auth-card__header">
      <a class="qt-brand" href="/" data-link><span data-field="product_name"></span></a>
    </header>
    <h2 id="qt-signin-title" data-t="routes.sign-in.title">Sign in</h2>

    <div data-slot="step">
      <div data-state="methods" class="qt-stack">
        <p class="qtiauth-lede" data-t="signIn.lede">Choose a way to sign in.</p>

        <section data-show="password" class="qt-stack">
          <h3 data-t="signIn.password.heading">Sign in with password</h3>
          <form data-form="password" class="qt-form" novalidate>
            <p class="qtiauth-field">
              <label for="qtiauth-f-email" data-t="field.email">Email</label>
              <input id="qtiauth-f-email" name="email" type="email" autocomplete="email" required />
            </p>
            <p class="qtiauth-field">
              <label for="qtiauth-f-password" data-t="field.password">Password</label>
              <input id="qtiauth-f-password" name="password" type="password" autocomplete="current-password" required />
            </p>
            <p class="qtiauth-actions">
              <button type="submit" data-t="signIn.submit">Sign in</button>
            </p>
          </form>
          <p><a href="/forgot" data-link data-t="signIn.forgot">Forgot your password?</a></p>
        </section>
      </div>
    </div>
  </section>
</div>
```

The shell wraps the template body. No `data-*` attributes are renamed. Buttons rely on the bare `<button>` default styling. Feedback blocks use `.qtiauth-feedback`.

### 9.2 Account surface - settings page (uses `qt-app-shell`)

```html
<div class="qt-app-shell">
  <header class="qt-app-nav">
    <div class="qt-app-nav__inner qt-container">
      <a class="qt-brand" href="/" data-link><span data-field="product_name"></span></a>
      <nav class="qt-app-nav__links" aria-label="Primary">
        <a href="/account" data-link data-current="page">Account</a>
        <a href="/support" data-link>Support</a>
      </nav>
      <div class="qt-cluster">
        <button class="qt-theme-toggle" type="button" data-action="toggle-theme" aria-label="Toggle theme"></button>
        <details class="qt-user-menu">
          <summary><span class="qt-avatar" data-field="initials"></span><span data-field="username"></span></summary>
          <ul>
            <li><button type="button" data-action="sign-out">Sign out</button></li>
          </ul>
        </details>
      </div>
    </div>
  </header>

  <div class="qt-app-body qt-container">
    <aside class="qt-app-sidebar">
      <nav class="qt-nav-list" aria-label="Account sections">
        <a href="/account/profile"       data-link>Profile</a>
        <a href="/account/email"         data-link>Email</a>
        <a href="/account/security"      data-link data-current="page">Security</a>
        <a href="/account/sessions"      data-link>Sessions</a>
        <a href="/account/methods"       data-link>Methods</a>
        <a href="/account/notifications" data-link>Notifications</a>
        <a href="/account/legal"         data-link>Legal</a>
        <a href="/account/data"          data-link>Data</a>
      </nav>
    </aside>

    <section class="qt-app-main qt-stack qt-stack--lg">
      <!-- page template contents go here, headings become h2 and h3 of the card -->
    </section>
  </div>
</div>
```

### 9.3 Admin surface - user list (uses `qt-admin-shell`, `qt-table`)

```html
<div class="qt-admin-shell">
  <aside class="qt-admin-sidebar"></aside>
  <div class="qt-admin-content">
    <header class="qt-admin-topbar">
      <nav class="qt-breadcrumb" aria-label="Breadcrumb">
        <ol><li><a href="/admin" data-link>Admin</a></li><li aria-current="page">Users</li></ol>
      </nav>
    </header>
    <main class="qt-admin-main qt-stack">
      <h2 data-t="routes.admin.users.title">Users</h2>

      <div data-slot="rows" class="qt-table-wrap">
        <table class="qt-table" data-variant="hoverable" data-state="list">
          <thead><tr><th>Username</th><th>Email</th></tr></thead>
          <tbody>
            <template data-item="rows">
              <tr>
                <td><a data-link data-bind-href="path" data-field="username"></a></td>
                <td><span data-field="email"></span></td>
              </tr>
            </template>
          </tbody>
        </table>
        <div class="qt-empty-state" data-state="empty">
          <h3 class="qt-empty-state__title" data-t="admin.empty">Nothing to show.</h3>
        </div>
        <div class="qt-message" data-variant="danger" data-state="error" role="alert" data-t="admin.load.error">Could not load data.</div>
      </div>
    </main>
  </div>
</div>
```

### 9.4 Support KB surface - article (uses `qt-kb-shell`)

```html
<div class="qt-kb-shell">
  <header class="qt-kb-topbar qt-container">
    <a class="qt-brand" href="/support" data-link><span data-field="product_name"></span> Help</a>
  </header>
  <article class="qt-kb-article">
    <h2 data-t="routes.kb.article.title" data-field="title">Article</h2>
    <div data-slot="article">
      <div data-state="ready">
        <p class="qtiauth-muted">
          <span data-field="category"></span> - <span data-field="updated_at"></span>
        </p>
        <div class="qtiauth-article" data-part="body"></div>
        <div class="qtiauth-status" data-part="feedback"></div>
        <p class="qtiauth-actions">
          <button type="button" data-action="helpful" data-t="kb.feedback.yes">Yes, this helped</button>
          <button type="button" class="qtiauth-button qtiauth-button-ghost" data-action="not-helpful" data-t="kb.feedback.no">No, this did not help</button>
        </p>
      </div>
      <div class="qt-empty-state" data-state="missing"><p data-t="kb.article.missing">That article is not available.</p></div>
      <div class="qt-message" data-variant="danger" data-state="error" role="alert" data-t="kb.article.load.error">Could not load article.</div>
    </div>
  </article>
</div>
```

### 9.5 Legal surface - document (uses `qt-kb-shell`)

Same wrapper as KB; the article content is driven by the server. Legal links in the footer of any shell always point to `/legal`.

---

## 10. Branding integration

### 10.1 Config to CSS mapping

| Config field                     | CSS custom property               | Theme file  |
| -------------------------------- | --------------------------------- | ----------- |
| `branding.colors.primary`        | `--qt-color-primary`              | `theme.css` |
| `branding.colors.accent`         | `--qt-color-accent`               | `theme.css` |
| `branding.colors.success`        | `--qt-color-success`              | `theme.css` |
| `branding.colors.warning`        | `--qt-color-warning`              | `theme.css` |
| `branding.colors.danger`         | `--qt-color-danger`               | `theme.css` |
| `branding.colors.text`           | `--qt-color-text`                 | `theme.css` |
| `branding.colors.text_muted`     | `--qt-color-text-muted`           | `theme.css` |
| `branding.colors.bg`             | `--qt-color-bg`                   | `theme.css` |
| `branding.colors.bg_secondary`   | `--qt-color-bg-secondary`         | `theme.css` |
| `branding.colors.border`         | `--qt-color-border`               | `theme.css` |
| `branding.colors.gradient_from`  | `--qt-color-gradient-from`        | `theme.css` |
| `branding.colors.gradient_to`    | `--qt-color-gradient-to`          | `theme.css` |
| `branding.backgrounds.auth_light`| `--qt-bg-auth-light` (as `url()`) | `theme.css` |
| `branding.backgrounds.auth_dark` | `--qt-bg-auth-dark`  (as `url()`) | `theme.css` |
| `branding.product_name`          | HTML text node (`data-field="product_name"`) | runtime  |
| `branding.company_name`          | HTML text node (`data-field="company_name"`) | runtime  |
| `branding.logo`                  | `<img>` src on `.qt-brand` logo slot          | runtime  |

### 10.2 Example output

For the QTI defaults, `theme.css` ends up as:

```css
:root {
  --qt-color-primary:      #5BB1EF;
  --qt-color-accent:       #BC6DE0;
  --qt-color-success:      #80D35D;
  --qt-color-warning:      #F7DA47;
  --qt-color-danger:       #DD5F5F;
  --qt-color-text:         #222034;
  --qt-color-text-muted:   #666577;
  --qt-color-bg:           #ffffff;
  --qt-color-bg-secondary: #f5f5f7;
  --qt-color-border:       #d1d1d6;
  --qt-color-gradient-from:#5BB1EF;
  --qt-color-gradient-to:  #BC6DE0;
  --qt-bg-auth-light:      url('https://cdn.quietterminal.co.uk/misc/LightBackground.png');
  --qt-bg-auth-dark:       url('https://cdn.quietterminal.co.uk/DarkBackground.png');
}
```

Dark overrides are produced by the same function from the dark colour fields.

### 10.3 Load order

`shell.ts` emits `<link rel="stylesheet" href="/theme.css">` before `<link rel="stylesheet" href="/styles.css">`. Agents keep that order; the main stylesheet depends on branding tokens already being defined.

---

## 11. Do and Don't

Do:

- Use `var(--qt-color-primary)`, never a hex literal.
- Use the spacing scale (`--qt-space-*`), never a raw `rem` or `px` for padding, margin, or gap.
- Use `data-variant`, `data-size`, `data-state` for component modifiers.
- Keep every page's top heading as `<h2>` inside the shell's `<main>`.
- Preserve `data-slot`, `data-show`, `data-form`, `data-state`, `data-action`, `data-field`, `data-bind-*`, `data-item`, `data-message`, `data-part`, `data-link`, `data-t` on existing template elements.
- Reuse the component CSS; alias legacy `qtiauth-` classes to it.
- Use native elements: `<button>`, `<dialog>`, `<details>`, `<fieldset>`, `<nav>`.
- Add `:focus-visible` styles whenever you remove the default outline.
- Guard every animation with `prefers-reduced-motion`.

Don't:

- Don't introduce Tailwind, Bootstrap, or any other CSS framework.
- Don't add web fonts; stick to the system stack.
- Don't hand-roll a new modal library; use `<dialog>`.
- Don't invent utility classes outside the bounded utility set in 8.3.
- Don't put colour values in HTML templates (`style="color: #fff"`).
- Don't rename `qtiauth-*` classes in the templates; the runtime depends on them.
- Don't use `display: none` for state-hidden text when screen readers must still see it; use `.qt-visually-hidden`.
- Don't block paint on JS to set the theme; set `data-theme` on `<html>` from the cookie, server-side.
- Don't use pixel values for spacing; use the scale.
- Don't bounce, parallax, or auto-play. Motion is subtle and short.
- Don't add icon libraries. Inline SVGs with `currentColor`.
