import { runService } from '@qtiauth/service-kit';

import { definition } from './service.ts';
import { gamesService } from './start.ts';

await runService(definition, gamesService());
