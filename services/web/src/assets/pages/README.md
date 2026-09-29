# Page templates

Every page of the web app is an HTML file in this folder. `<id>.html` is the
page with that id in `PAGES` (in `../pages.js`), and `_<name>.html` is a partial
that pages share. The server bundles them all into `/templates.html` at start.

Edit the HTML to change a page's markup, copy, order or classes. The page's
function in `pages.js` only loads data and fills the placeholders below. Most
edits touch only the HTML. You only need `pages.js` when a page needs new data.

The shell's CSP blocks `<script>`, inline `on…=` handlers and `style=`
attributes, so put behaviour in `pages.js` and styling in `../styles.css`.

## Placeholders

| Attribute                             | Meaning                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-t="key"`                        | Translatable text. The element's own text is the English copy, and a locale file may override it by key. Only put it on elements with no child elements.             |
| `{name}` inside `data-t` text         | Replaced with a value the page supplies.                                                                                                                             |
| `data-field="name"`                   | The element's text becomes that value. Any text written in the HTML shows until the value arrives, or when the value is missing.                                     |
| `data-bind-<attr>="name"`             | Sets the attribute `<attr>` from that value, for example `data-bind-href="url"` or `data-bind-value="token"`. `true` or `false` adds or removes a boolean attribute. |
| `<a href="/path" data-link>`          | A link inside the app. It navigates without a page load. Use it together with `data-bind-href` when the path is dynamic.                                             |
| `data-show="flag"` / `"!flag"`        | Removed unless (or if) the page sets `flag`.                                                                                                                         |
| `data-action="name"`                  | A button the page attaches a click handler to.                                                                                                                       |
| `<form data-form="name">`             | A form the page submits. Input `name`s become the submitted values. Errors, and a `.qtiauth-feedback` area if the form has none, are added automatically.            |
| `<template data-message="name">`      | A message the page shows on success, such as `success` inside a form.                                                                                                |
| `<template data-item="name">`         | One row of a list. Rows are inserted where the template sits, one per item.                                                                                          |
| `data-slot="name"` + `data-state="…"` | States of an area that loads data. Only one state shows at a time. `list` and `empty` switch automatically for the list named `name`. `loading` shows until then.    |
| `data-part="name"`                    | A container the page fills itself, such as an article body or a partial.                                                                                             |

## Example

```html
<div data-slot="sessions">
  <ul class="qtiauth-list" data-state="list">
    <template data-item="sessions">
      <li>
        <span data-field="user_agent">unknown</span>
        <button type="button" data-action="revoke" data-t="sessions.revoke">Revoke</button>
      </li>
    </template>
  </ul>
  <p class="qtiauth-empty" data-state="empty" data-t="sessions.empty">No other sessions.</p>
  <p class="qtiauth-empty" data-state="error" data-t="sessions.load.error">
    Could not load sessions.
  </p>
</div>
```

```js
view.list('sessions', data.items, (session, row) => {
  row.fill({ user_agent: session.user_agent });
  row.on('revoke', () => s.revoke(session.id));
});
```

If a page's function asks for a `data-form`, `data-action`, `data-slot`, `data-part` or
`data-message` that the HTML no longer has, the page shows an error that names
the missing attribute. Keep those names in sync when you rename
them.

## Adding a page

1. Add `<id>.html` here.
2. Add `<id>` to `PAGES` in `pages.js`. Include a `render` function only if the page loads data or
   handles input.
