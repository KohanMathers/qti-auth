import {
  type JsonSchema,
  type OpenApiDocument,
  OPENAPI_VERSION,
  openApiPath,
  PROBLEM_CONTENT_TYPE,
} from '@qtiauth/service-kit';

import { ERRORS } from './errors.ts';
import { impliedGatewayErrors } from './policy.ts';
import type { RouteTable } from './routes.ts';
import type { Surface } from './surfaces.ts';

export interface MergeOptions {
  surface: Surface;
  table: RouteTable;
  documents: ReadonlyMap<string, OpenApiDocument | null>;
  title: string;
  version: string;
}

interface ErrorEntry {
  code: string;
  status: number;
  title: string;
}

type Operation = JsonSchema & { operationId?: string; responses?: Record<string, JsonSchema> };

function addErrors(operation: Operation, codes: readonly string[]): Operation {
  const responses = { ...(operation.responses ?? {}) };
  for (const code of codes) {
    const definition = ERRORS[code];
    if (!definition) continue;
    const status = String(definition.status);
    const existing = responses[status];
    const known = (existing?.['x-qtiauth-error-codes'] ?? []) as string[];
    if (known.includes(code)) continue;
    const merged = [...known, code];
    responses[status] = {
      description: merged.join(', '),
      content: {
        [PROBLEM_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ProblemDetails' } },
      },
      'x-qtiauth-error-codes': merged,
    };
  }
  return { ...operation, responses };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function mergeOpenApi(options: MergeOptions): OpenApiDocument {
  const paths: Record<string, Record<string, Operation>> = {};
  const errors = new Map<string, ErrorEntry>();
  const operationIds = new Set<string>();
  const unavailable = new Set<string>();
  let problemSchema: JsonSchema | undefined;

  for (const mount of options.table.mounts) {
    if (mount.surface !== options.surface.name) continue;
    const { service, route } = mount.route;
    const document = options.documents.get(service);
    if (!document) {
      unavailable.add(service);
      continue;
    }
    const servicePaths = (document['paths'] ?? {}) as Record<string, Record<string, Operation>>;
    const operation = servicePaths[openApiPath(route.path)]?.[route.method.toLowerCase()];
    if (!operation) continue;

    const components = document['components'] as
      { schemas?: Record<string, JsonSchema> } | undefined;
    problemSchema ??= components?.schemas?.['ProblemDetails'];
    for (const entry of (document['x-qtiauth-errors'] ?? []) as ErrorEntry[]) {
      errors.set(entry.code, entry);
    }

    let operationId =
      operation.operationId ?? `${service}${capitalize(route.method.toLowerCase())}`;
    if (operationIds.has(operationId)) operationId = `${service}${capitalize(operationId)}`;
    operationIds.add(operationId);

    const merged = addErrors(
      { ...operation, operationId, 'x-qtiauth-service': service },
      impliedGatewayErrors(mount.route),
    );
    (paths[openApiPath(mount.path)] ??= {})[route.method.toLowerCase()] = merged;
  }

  for (const [code, definition] of Object.entries(ERRORS)) {
    if (!errors.has(code)) errors.set(code, { code, ...definition });
  }

  return {
    openapi: OPENAPI_VERSION,
    info: { title: options.title, version: options.version },
    servers: [{ url: options.surface.basePath }],
    paths,
    components: { schemas: problemSchema ? { ProblemDetails: problemSchema } : {} },
    'x-qtiauth-surface': options.surface.name,
    'x-qtiauth-errors': [...errors.values()].sort((a, b) => a.code.localeCompare(b.code)),
    ...(unavailable.size > 0 ? { 'x-qtiauth-unavailable-services': [...unavailable].sort() } : {}),
  };
}
