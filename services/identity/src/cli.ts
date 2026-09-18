#!/usr/bin/env node
import { runServiceCli } from '@qtiauth/service-kit';

import { adminCreate } from './admin-create.ts';
import { auditVerify } from './audit-verify.ts';
import { definition, router } from './service.ts';

await runServiceCli(definition, router, {
  'admin create': adminCreate,
  'audit verify': auditVerify,
});
