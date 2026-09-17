import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { notifierService } from './start.ts';

await runService(definition, notifierService());
