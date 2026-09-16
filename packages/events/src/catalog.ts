import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import envelopeSchema from '../schemas/envelope.json' with { type: 'json' };
import type { EventEnvelope } from './envelope.ts';
import { EventTypeError, parseEventType } from './event-type.ts';

export const SCHEMAS_DIR = join(import.meta.dirname, '../schemas');
export const ENVELOPE_SCHEMA_FILE = 'envelope.json';

export type EventValidation =
  { valid: true; event: EventEnvelope } | { valid: false; issues: string[] };

export interface EventCatalog {
  readonly types: readonly string[];
  validate: (event: unknown) => EventValidation;
}

export class EventSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventSchemaError';
  }
}

export class EventContractError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Event doesn't match its schema:\n${issues.map((issue) => `  ${issue}`).join('\n')}`);
    this.name = 'EventContractError';
    this.issues = issues;
  }
}

export function eventSchemaId(type: string): string {
  return `urn:qtiauth:event:${type}`;
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  return ajv;
}

const envelopeAjv = createAjv();
const validateEnvelopeSchema = envelopeAjv.compile<EventEnvelope>(envelopeSchema);

function issues(errors: ErrorObject[] | null | undefined, prefix = ''): string[] {
  return (errors ?? []).map(
    (error) => `${prefix + error.instancePath || '/'}: ${error.message ?? 'is invalid'}`,
  );
}

export function validateEnvelope(value: unknown): EventValidation {
  if (validateEnvelopeSchema(value)) {
    return { valid: true, event: value };
  }
  return { valid: false, issues: issues(validateEnvelopeSchema.errors) };
}

function typeFromPath(file: string): string {
  const parts = file.split(sep);
  const [source, name] = parts;
  if (parts.length !== 2 || source === undefined || name === undefined) {
    throw new EventSchemaError(
      `Event schema ${file} must be at <service>/<entity>.<verb>.v<n>.json`,
    );
  }
  const type = `qtiauth.${source}.${name.slice(0, -'.json'.length)}`;
  try {
    parseEventType(type);
  } catch (error) {
    if (!(error instanceof EventTypeError)) throw error;
    throw new EventSchemaError(`Event schema ${file}: ${error.message}`);
  }
  return type;
}

export async function loadEventCatalog(dir: string = SCHEMAS_DIR): Promise<EventCatalog> {
  const ajv = createAjv();
  const validators = new Map<string, ValidateFunction>();
  const files = (await readdir(dir, { recursive: true }))
    .filter((file) => file.endsWith('.json') && file !== ENVELOPE_SCHEMA_FILE)
    .sort();

  for (const file of files) {
    const type = typeFromPath(file);
    const schema = JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, unknown>;
    if (schema['$id'] !== eventSchemaId(type)) {
      throw new EventSchemaError(`Event schema ${file} must have "$id": "${eventSchemaId(type)}"`);
    }
    try {
      validators.set(type, ajv.compile(schema));
    } catch (error) {
      throw new EventSchemaError(`Event schema ${file} is invalid: ${(error as Error).message}`);
    }
  }

  return {
    types: [...validators.keys()],
    validate(value) {
      const envelope = validateEnvelope(value);
      if (!envelope.valid) return envelope;
      const { event } = envelope;
      const validateData = validators.get(event.type);
      if (!validateData) {
        return { valid: false, issues: [`/type: no schema for event type ${event.type}`] };
      }
      if (validateData(event.data)) return envelope;
      return { valid: false, issues: issues(validateData.errors, '/data') };
    },
  };
}

export function assertEventContract(
  catalog: EventCatalog,
  events: EventEnvelope | readonly EventEnvelope[],
): void {
  for (const event of [events].flat()) {
    const result = catalog.validate(event);
    if (!result.valid) {
      throw new EventContractError(result.issues.map((issue) => `${event.type} ${issue}`));
    }
  }
}
