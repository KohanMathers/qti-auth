import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { webService } from './start.ts';

await runService(definition, webService());
