import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { schedulerService } from './start.ts';

await runService(definition, schedulerService());
