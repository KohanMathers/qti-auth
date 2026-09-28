import type { BackupDestination, BackupHandle } from './destination.ts';
import { deleteBackup, listBackups } from './destination.ts';

export interface EnforceRetentionOptions {
  destination: BackupDestination;
  retention: number;
  now: Date;
  keepAtLeast?: number;
}

export interface RetentionResult {
  kept: BackupHandle[];
  deleted: BackupHandle[];
}

export async function enforceRetention(options: EnforceRetentionOptions): Promise<RetentionResult> {
  const keepAtLeast = options.keepAtLeast ?? 1;
  const cutoff = new Date(options.now.getTime() - options.retention);
  const all = (await listBackups(options.destination)).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const kept: BackupHandle[] = [];
  const deleted: BackupHandle[] = [];
  for (const handle of all) {
    const olderThanCutoff = handle.createdAt.getTime() <= cutoff.getTime();
    if (kept.length < keepAtLeast || !olderThanCutoff) {
      kept.push(handle);
      continue;
    }
    await deleteBackup(options.destination, handle.id);
    deleted.push(handle);
  }
  return { kept, deleted };
}
