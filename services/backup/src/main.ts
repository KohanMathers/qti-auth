import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { backupService } from './start.ts';

await runService(definition, backupService());
