export interface ClientProblemMessage {
  title: string;
  detail: string;
}

export const CATALOGUE: Readonly<Record<string, ClientProblemMessage>>;

export function messageFor(code: string): ClientProblemMessage;
