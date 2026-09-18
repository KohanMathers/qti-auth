export interface StoredObject {
  key: string;
  lastModified: Date;
  size: number;
}

export interface ObjectStore {
  put: (key: string, body: Uint8Array, contentType: string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | undefined>;
  delete: (key: string) => Promise<void>;
  deletePrefix: (prefix: string) => Promise<number>;
  list: (prefix: string) => Promise<StoredObject[]>;
  presignGet: (key: string, expiresSeconds: number) => Promise<string>;
  presignPut: (key: string, contentType: string, expiresSeconds: number) => Promise<string>;
  /** Resolves when the bucket is reachable, without listing it. */
  checkBucket: () => Promise<void>;
  ensureBucket: () => Promise<void>;
  close: () => Promise<void>;
}

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}
