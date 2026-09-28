import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '../../..');
const observability = join(root, 'deploy/observability');

function readText(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function walk(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walk(path, pattern));
    } else if (pattern.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

const SOURCE_DIRS = ['packages', 'services'];
const METRIC_PATTERN = /qtiauth_[a-z0-9_]+/g;

function baseName(name: string): string {
  return name.replace(/_(bucket|count|sum)$/, '');
}

function definedMetrics(): Set<string> {
  const names = new Set<string>();
  const definition = /name:\s*'(qtiauth_[a-z0-9_]+)'/g;
  for (const source of SOURCE_DIRS) {
    for (const file of walk(join(root, source), /\.ts$/)) {
      if (file.endsWith('.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const [, name] of text.matchAll(definition)) {
        if (name) names.add(name);
      }
    }
  }
  return names;
}

function dashboardText(): string {
  const files = walk(join(observability, 'grafana/dashboards'), /\.json$/);
  return files.map((path) => readFileSync(path, 'utf8')).join('\n');
}

function alertRules(): { name: string; expr: string }[] {
  const yaml = parse(readText('deploy/observability/prometheus/alerts.yml')) as {
    groups: { rules: { alert: string; expr: string }[] }[];
  };
  return yaml.groups.flatMap((group) =>
    group.rules.map((rule) => ({ name: rule.alert, expr: rule.expr })),
  );
}

describe('deploy/observability', () => {
  const dashboards = dashboardText();
  const metrics = definedMetrics();

  it('has a dashboard for every area listed in SPEC §8.6', () => {
    const expected = [
      'stack-overview',
      'gateway',
      'auth-and-sessions',
      'bus',
      'notifier',
      'oidc',
      'safety',
      'support',
      'games',
      'infra',
    ];
    const files = readdirSync(join(observability, 'grafana/dashboards'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.replace(/\.json$/, ''));
    expect(files.sort()).toEqual([...expected].sort());
  });

  it('references every defined qtiauth_ metric from at least one dashboard', () => {
    const referenced = new Set([...(dashboards.match(METRIC_PATTERN) ?? [])].map(baseName));
    const missing = [...metrics].filter((name) => !referenced.has(name)).sort();
    expect(missing, missing.join(', ')).toEqual([]);
  });

  it('names alert rules from the SPEC §8.6 catalogue', () => {
    const rules = alertRules().map((rule) => rule.name);
    expect(rules).toEqual(
      expect.arrayContaining([
        'HttpErrorRateHigh',
        'AuthPasswordFailureSpike',
        'AuthSignInFailureSpike',
        'OutboxBacklogAgeHigh',
        'BusConsumerLagHigh',
        'WebhookEndpointsAutoDisabled',
        'SafetySlaBreach',
        'SupportFirstResponseSlow',
        'BackupRunFailed',
        'SigningKeyRotationOverdue',
        'EdgeCertificateExpirySoon',
      ]),
    );
  });

  it('references only qtiauth_ metrics that exist, or expected framework metrics', () => {
    const rulesText = readText('deploy/observability/prometheus/alerts.yml');
    const referenced = [...(rulesText + dashboards).matchAll(METRIC_PATTERN)].map(([name]) =>
      baseName(name),
    );
    const unknown = new Set(referenced.filter((name) => !metrics.has(name)));
    unknown.delete('qtiauth_edge_certificate_expiry_timestamp_seconds');
    expect([...unknown].sort()).toEqual([]);
  });
});
