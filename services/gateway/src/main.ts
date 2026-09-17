import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { gatewayService } from './start.ts';

await runService(definition, gatewayService().options);
