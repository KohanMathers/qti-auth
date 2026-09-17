# Configuration

QTIAuth reads one YAML file, `qtiauth.yaml`, plus secrets from the environment. This page covers how that file is found, written and checked. For what each setting does, see the JSON Schema at [`config/qtiauth.schema.json`](../config/qtiauth.schema.json), which has a description and default for every setting.

The `database` section and the Postgres roles it references are covered in [database.md](database.md), the `bus` section in [bus.md](bus.md), the `observability` section in [observability.md](observability.md), the `service` section in [services.md](services.md), the `scheduler` section in [scheduler.md](scheduler.md), the `email` and `retention` sections in [notifier.md](notifier.md), the `accounts`, `magic_link`, `password`, `captcha`, `sessions`, `session_security`, `geoip`, `age`, `parental`, `security` and `features.auth.social` sections and the session settings in `cookies` and `retention` in [identity.md](identity.md), and the `gateway`, `valkey`, `rate_limits` and `security` sections, surface origins and the session cookie in [gateway.md](gateway.md). Running the stack is covered in [deployment.md](deployment.md).

## Where config lives

```
config/
  qtiauth.yaml           # every non-secret setting
  qtiauth.dev.yaml       # development config, used by deploy/compose.dev.yaml
  qtiauth.schema.json    # JSON Schema, generated
.env                     # secrets only
```

Services read `config/qtiauth.yaml` relative to their working directory. Set `QTIAUTH_CONFIG` to use a different path.

The shipped `config/qtiauth.yaml` is brand-neutral (`Example`, `example.com`) and matches the built-in defaults apart from its example hostnames. Copy it and change what your deployment needs. Every setting has a default, so you can leave out anything you don't change.

## Secrets

Secrets never go in `qtiauth.yaml`. Reference them instead:

| Reference       | Value                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| `${env:NAME}`   | The environment variable `NAME`. An empty value is allowed.             |
| `${file:/path}` | The contents of a file, minus one trailing newline. For Docker secrets. |
| `$${…}`         | A literal `${…}`, not a reference.                                      |

- References work anywhere inside a string value, e.g. `postgres://app:${env:DB_PASSWORD}@db/app`. Keys are never interpolated.
- Relative `${file:…}` paths resolve against the directory containing `qtiauth.yaml`.
- A reference to an unset variable, an unreadable file, or anything other than `env:` or `file:` is an error.
- Interpolation happens after the YAML is parsed, so a secret's contents can't change the structure of the file.
- Inside YAML flow collections (`{ … }` or `[ … ]`), quote values that contain references: `{ client_secret: '${env:SECRET}' }`.

`.env.example` lists every variable the shipped config references. Copy it to `.env` and fill it in.

## Formats

- Durations are an integer and a unit: `250ms`, `30s`, `15m`, `12h`, `7d`, `2w`.
- Hosts are bare hostnames with no scheme or port. Use `ports` for port-based surfaces.
- Origins are a scheme, host and optional port with no path: `https://app.example.com`.
- Trusted proxies are IP addresses or CIDR ranges: `10.0.0.0/8`, `fd00::/8`.

## Validation

Config is validated when each service starts. If anything is wrong the service prints every problem and exits with status 1, without starting. Each problem names the setting's YAML path and its line and column:

```
Invalid config in config/qtiauth.yaml:
  surfaces.support.base_path (line 17, column 49): Must start with "/" and not end with "/", e.g. / or /support
  cookies.sesion_ttl (line 21, column 16): Unknown setting
  features.auth.social.google.client_id (line 47, column 20): Environment variable GOOGLE_CLIENT_ID is not set
```

Unknown settings are errors, so typos don't silently fall back to defaults.

### Checking config without starting anything

```sh
qtiauth config check [--config <path>] [--env-file <path>]
```

Validates the whole file, including every reference, and exits 0 if it's valid or 1 if it isn't. `--env-file` reads variables from a `.env` file. Variables already set in the environment take precedence. In this repository, run it with `pnpm qtiauth config check --env-file .env`.

## Editor support

`config/qtiauth.yaml` starts with a `yaml-language-server` comment pointing at the JSON Schema, so editors with YAML language support offer completion, descriptions and validation. If you keep your config elsewhere, point the comment at a copy of the schema.

---

## For developers

### Reading config in a service

A service validates only the sections it reads, and ignores sections owned by other services:

```ts
import { loadConfigOrExit, serviceConfigSchema } from '@qtiauth/config';

const config = await loadConfigOrExit(serviceConfigSchema(['branding', 'cookies', 'surfaces']));
config.cookies.session_ttl;
```

`loadConfigOrExit` prints the error and exits on invalid config. `loadConfig` throws a `ConfigError` instead, whose `issues` list each problem's path, message, line and column.

### Adding settings

Section schemas live in `packages/config/src/sections.ts`, and each top-level section is registered in `sections`. Every setting needs a default and a `.describe()` text, so it appears in the JSON Schema. Use `z.strictObject` so unknown keys are rejected, and `.prefault({})` on objects so their defaults apply when the object is left out. Durations use `duration()`.

After changing a schema, regenerate the JSON Schema:

```sh
pnpm config:schema
```

A unit test fails if `config/qtiauth.schema.json` is out of date, if the shipped `config/qtiauth.yaml` stops matching the defaults, or if `config/qtiauth.dev.yaml` differs from them in anything but the `console` email provider or references different secrets. Add a new secret reference to both files.
