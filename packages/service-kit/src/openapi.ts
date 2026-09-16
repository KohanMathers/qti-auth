import * as z from 'zod';

import { PROBLEM_CONTENT_TYPE } from './problems.ts';
import { impliedErrors, manifestRoute, type RouteInfo, type Router } from './routes.ts';

export const OPENAPI_VERSION = '3.1.1';

export type JsonSchema = Record<string, unknown>;
export type OpenApiDocument = Record<string, unknown>;

const problemDetailsSchema: JsonSchema = {
  type: 'object',
  description: 'RFC 9457 Problem Details. Branch on code, not on title or detail.',
  required: ['type', 'title', 'status', 'code'],
  properties: {
    type: { type: 'string', description: 'urn:qtiauth:problem:<code>' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: { type: 'string', description: 'Stable machine-readable error code.' },
    detail: { type: 'string' },
    request_id: { type: 'string' },
  },
  additionalProperties: true,
};

export function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const converted = z.toJSONSchema(schema, {
    io,
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
  return Object.fromEntries(Object.entries(converted).filter(([key]) => key !== '$schema'));
}

export function openApiPath(path: string): string {
  return path.replaceAll(/:([a-z][a-z0-9_]*)/g, '{$1}');
}

function parameters(schema: z.ZodObject | undefined, location: 'path' | 'query'): JsonSchema[] {
  if (!schema) return [];
  const object = jsonSchema(schema, 'input');
  const properties = (object['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((object['required'] ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...propertySchema } = property;
    return {
      name,
      in: location,
      required: location === 'path' || required.has(name),
      ...(typeof description === 'string' ? { description } : {}),
      schema: propertySchema,
    };
  });
}

function operation<Ctx>(router: Router<Ctx>, route: RouteInfo): JsonSchema {
  const responses: Record<string, JsonSchema> = {};
  for (const [status, response] of Object.entries(route.responses)) {
    responses[status] = {
      description: response.description,
      ...(response.schema
        ? { content: { 'application/json': { schema: jsonSchema(response.schema, 'output') } } }
        : {}),
    };
  }

  const byStatus = new Map<number, string[]>();
  for (const code of new Set([...impliedErrors(route), ...route.errors])) {
    const definition = router.errors[code];
    if (!definition) continue;
    byStatus.set(definition.status, [...(byStatus.get(definition.status) ?? []), code]);
  }
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    responses[String(status)] = {
      description: codes.join(', '),
      content: {
        [PROBLEM_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/ProblemDetails' } },
      },
      'x-qtiauth-error-codes': codes,
    };
  }

  const { body } = route.request;
  return {
    operationId: route.operation_id,
    summary: route.summary,
    ...(route.description === undefined ? {} : { description: route.description }),
    ...(route.tags.length > 0 ? { tags: [...route.tags] } : {}),
    parameters: [
      ...parameters(route.request.params, 'path'),
      ...parameters(route.request.query, 'query'),
    ],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchema(body, 'input') } },
          },
        }
      : {}),
    responses,
    'x-qtiauth-policy': manifestRoute(route),
  };
}

export interface OpenApiOptions {
  title?: string;
  description?: string;
}

export function openApiDocument<Ctx>(
  router: Router<Ctx>,
  options: OpenApiOptions = {},
): OpenApiDocument {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const route of router.routes) {
    const path = (paths[openApiPath(route.path)] ??= {});
    path[route.method.toLowerCase()] = operation(router, route);
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: options.title ?? `QTIAuth ${router.service}`,
      version: router.version,
      ...(options.description === undefined ? {} : { description: options.description }),
    },
    paths,
    components: { schemas: { ProblemDetails: problemDetailsSchema } },
    'x-qtiauth-service': router.service,
    'x-qtiauth-errors': Object.entries(router.errors)
      .map(([code, definition]) => ({ code, ...definition }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    'x-qtiauth-permissions': Object.values(router.permissions).map((permission) => ({
      ...permission,
    })),
  };
}
