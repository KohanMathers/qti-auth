#!/usr/bin/env node
import { runServiceCli } from '@qtiauth/service-kit';

import { backupRestore } from './restore.ts';
import { definition, router } from './service.ts';
import { backupVerify } from './verify.ts';

await runServiceCli(definition, router, {
  'backup verify': backupVerify,
  'backup restore': backupRestore,
});
