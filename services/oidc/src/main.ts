import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { oidcService } from './start.ts';

await runService(definition, oidcService());
