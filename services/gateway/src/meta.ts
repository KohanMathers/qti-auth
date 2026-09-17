import type { QtiauthConfig } from '@qtiauth/config';
import { escapeHtml } from '@qtiauth/email';
import type { GeoIp } from '@qtiauth/geoip';
import * as z from 'zod';

import type { RunningService } from './discovery.ts';
import type { RouteProblem } from './routes.ts';
import { DEFAULT_MODULES, type Module, type Surface, surfacePairs } from './surfaces.ts';

export type MetaConfig = Pick<QtiauthConfig, 'branding' | 'features' | 'geoip'>;

export const CORE_SERVICES = ['identity', 'notifier', 'scheduler'] as const;

export const MODULE_SERVICES: Record<Module, string> = {
  identity: 'identity',
  admin: 'identity',
  oidc: 'oidc',
  games: 'games',
  safety: 'safety',
  support: 'support',
};

const OPTIONAL_FEATURE_SERVICES = ['oidc', 'games', 'support'] as const;

const SOCIAL_NAMES = { google: 'Google', github: 'GitHub', discord: 'Discord', steam: 'Steam' };

const problemSchema = z
  .object({ code: z.string() })
  .catchall(z.unknown())
  .describe('A problem with the running stack. Branch on code.');

export const healthSchema = z.object({
  status: z.enum(['ok', 'starting', 'degraded']),
  services: z.array(z.object({ name: z.string(), instances: z.int() })),
  problems: z.array(problemSchema),
});

export type Health = z.output<typeof healthSchema>;

export type HealthProblem =
  | RouteProblem
  | { code: 'SERVICE_NOT_RUNNING'; service: string }
  | { code: 'FEATURE_SERVICE_NOT_RUNNING'; feature: string; service: string }
  | { code: 'CROSS_SITE_SURFACES'; surfaces: [string, string] }
  | { code: 'GEOIP_UNAVAILABLE'; source: string };

const toggles = z.record(z.string(), z.boolean());

export const featuresSchema = z.object({
  branding: z.object({
    product_name: z.string(),
    company_name: z.string(),
    support_email: z.string(),
    colors: z.object({ primary: z.string() }),
  }),
  modules: z.record(z.string(), z.boolean()),
  auth: z.object({
    methods: toggles,
    social: z.array(z.object({ id: z.string(), name: z.string(), icon: z.string().nullable() })),
    session_security: z.boolean(),
  }),
  features: z.record(z.string(), toggles),
  surfaces: z.array(
    z.object({
      name: z.string(),
      origins: z.array(z.string()),
      base_path: z.string(),
      modules: z.array(z.string()),
    }),
  ),
  surface_pairs: z.array(
    z.object({ surfaces: z.tuple([z.string(), z.string()]), same_site: z.boolean() }),
  ),
});

export type Features = z.output<typeof featuresSchema>;

export const aboutSchema = z.object({
  product_name: z.string(),
  geoip: z.object({
    source: z.string(),
    available: z.boolean(),
    attribution: z
      .object({
        name: z.string(),
        product: z.string(),
        url: z.string(),
        license: z.string(),
        license_url: z.string(),
        notice: z.string(),
      })
      .nullable(),
  }),
});

export type About = z.output<typeof aboutSchema>;

/** What meta reports needs from the opened database: the one source of truth for availability. */
export type GeoipStatus = Pick<GeoIp, 'available' | 'attribution'>;

export function aboutReport(config: MetaConfig, geoip: GeoipStatus): About {
  return {
    product_name: config.branding.product_name,
    geoip: {
      source: config.geoip.source,
      available: geoip.available,
      attribution: geoip.attribution,
    },
  };
}

export function aboutHtml(about: About): string {
  const credit = about.geoip.attribution;
  const body = credit
    ? `<p>${escapeHtml(credit.notice)}.</p>
<p><a href="${escapeHtml(credit.url)}">${escapeHtml(credit.name)} ${escapeHtml(credit.product)}</a>
 is licensed under <a href="${escapeHtml(credit.license_url)}">${escapeHtml(credit.license)}</a>.</p>`
    : '<p>This deployment does not use a GeoIP database that requires attribution.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>About · ${escapeHtml(about.product_name)}</title>
</head>
<body>
<main>
<h1>About ${escapeHtml(about.product_name)}</h1>
${body}
</main>
</body>
</html>
`;
}

export function enabledFeatures(
  features: QtiauthConfig['features'],
): { feature: string; service: string }[] {
  return OPTIONAL_FEATURE_SERVICES.flatMap((service) =>
    Object.entries(features[service])
      .filter(([, value]) => value.enabled)
      .map(([name]) => ({ feature: `features.${service}.${name}.enabled`, service })),
  );
}

export interface HealthInput {
  config: MetaConfig;
  services: readonly RunningService[];
  routeProblems: readonly RouteProblem[];
  starting: boolean;
  surfaces?: readonly Surface[];
  geoip?: GeoipStatus;
}

/** Problems worth reporting that do not make the stack degraded. */
const ADVISORY_PROBLEMS = new Set<HealthProblem['code']>([
  'CROSS_SITE_SURFACES',
  'GEOIP_UNAVAILABLE',
]);

export function healthReport(input: HealthInput): Health {
  const running = new Set(input.services.map((service) => service.name));
  const problems: HealthProblem[] = [
    ...CORE_SERVICES.filter((service) => !running.has(service)).map((service) => ({
      code: 'SERVICE_NOT_RUNNING' as const,
      service,
    })),
    ...enabledFeatures(input.config.features)
      .filter(({ service }) => !running.has(service))
      .map(({ feature, service }) => ({
        code: 'FEATURE_SERVICE_NOT_RUNNING' as const,
        feature,
        service,
      })),
    ...input.routeProblems,
    ...surfacePairs(input.surfaces ?? [])
      .filter((pair) => !pair.same_site)
      .map((pair) => ({
        code: 'CROSS_SITE_SURFACES' as const,
        surfaces: pair.surfaces,
      })),
    ...(input.geoip === undefined || input.geoip.available
      ? []
      : [{ code: 'GEOIP_UNAVAILABLE' as const, source: input.config.geoip.source }]),
  ];
  const degrading = problems.filter((problem) => !ADVISORY_PROBLEMS.has(problem.code));
  let status: Health['status'] = 'ok';
  if (degrading.length > 0) status = input.starting ? 'starting' : 'degraded';
  return {
    status,
    services: input.services
      .filter((service) => service.name !== 'gateway')
      .map(({ name, instances }) => ({ name, instances })),
    problems,
  };
}

export interface FeaturesInput {
  config: MetaConfig;
  surfaces: readonly Surface[];
  isRunning: (service: string) => boolean;
}

export function featuresReport(input: FeaturesInput): Features {
  const { branding, features } = input.config;
  const { auth } = features;
  const identity = input.isRunning('identity');
  const toggleMap = (entries: Record<string, { enabled: boolean }>, running: boolean) =>
    Object.fromEntries(
      Object.entries(entries).map(([name, value]) => [name, running && value.enabled]),
    );

  return {
    branding: {
      product_name: branding.product_name,
      company_name: branding.company_name,
      support_email: branding.support_email,
      colors: branding.colors,
    },
    modules: Object.fromEntries(
      Object.entries(MODULE_SERVICES).map(([module, service]) => [
        module,
        input.isRunning(service),
      ]),
    ),
    auth: {
      methods: toggleMap(
        {
          password: auth.password,
          magic_link: auth.magic_link,
          passkeys: auth.passkeys,
          totp: auth.totp,
        },
        identity,
      ),
      social: identity
        ? [
            ...(['google', 'github', 'discord', 'steam'] as const)
              .filter((id) => auth.social[id].enabled)
              .map((id) => ({ id, name: SOCIAL_NAMES[id], icon: null })),
            ...auth.social.generic_oidc.map(({ id, name, icon }) => ({ id, name, icon })),
          ]
        : [],
      session_security: identity && features.session_security.enabled,
    },
    features: Object.fromEntries(
      OPTIONAL_FEATURE_SERVICES.map((service) => [
        service,
        toggleMap(features[service], input.isRunning(service)),
      ]),
    ),
    surfaces: input.surfaces.map((surface) => ({
      name: surface.name,
      origins: [...surface.origins],
      base_path: surface.basePath,
      modules: [...surface.modules].filter((module) => DEFAULT_MODULES.api.includes(module)),
    })),
    surface_pairs: surfacePairs(input.surfaces),
  };
}
