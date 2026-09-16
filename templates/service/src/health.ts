export interface HealthStatus {
  status: 'ok';
  service: string;
}

export function health(service: string): HealthStatus {
  return { status: 'ok', service };
}
