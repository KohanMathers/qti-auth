import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { supportService } from './start.ts';

await runService(definition, supportService());
