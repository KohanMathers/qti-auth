export const SUBJECT_PREFIX = 'qtiauth';

const TOKEN = /^[a-z][a-z0-9_]*$/;
const DOTTED = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const NAME = /^[A-Za-z0-9_-]+$/;

export class SubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubjectError';
  }
}

function check(pattern: RegExp, value: string, what: string): string {
  if (!pattern.test(value)) {
    throw new SubjectError(`Invalid ${what}: ${value}`);
  }
  return value;
}

export function rpcSubject(service: string, method: string): string {
  return `${SUBJECT_PREFIX}.rpc.${check(TOKEN, service, 'service name')}.${check(TOKEN, method, 'RPC method')}`;
}

export function rpcQueueGroup(service: string): string {
  return `${SUBJECT_PREFIX}.rpc.${check(TOKEN, service, 'service name')}`;
}

export function cronSubject(job: string): string {
  return `${SUBJECT_PREFIX}.sys.cron.${check(DOTTED, job, 'cron job name')}`;
}

export function workSubject(service: string, queue: string): string {
  return `${SUBJECT_PREFIX}.work.${check(TOKEN, service, 'service name')}.${check(DOTTED, queue, 'work queue name')}`;
}

export function consumerName(...parts: string[]): string {
  return check(NAME, parts.join('-').replaceAll('.', '_'), 'consumer name');
}
