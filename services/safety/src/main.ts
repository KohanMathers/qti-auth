import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { safetyService } from './start.ts';

await runService(definition, safetyService());
