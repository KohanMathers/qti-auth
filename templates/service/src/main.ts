import { runService } from '@qtiauth/service-kit';

import { definition, router } from './service.ts';

await runService(definition, { router });
