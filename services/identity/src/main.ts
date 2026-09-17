import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { identityService } from './start.ts';

await runService(definition, identityService());
