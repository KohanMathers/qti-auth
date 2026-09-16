# Changesets

Every PR that changes a package or service adds a changeset:

```sh
pnpm changeset
```

Pick the affected packages, the bump type, and write a one-line summary. Changesets are collected
into each package's `CHANGELOG.md` when versions are released.
