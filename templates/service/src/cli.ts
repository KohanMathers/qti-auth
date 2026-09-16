#!/usr/bin/env node
import { runServiceCli } from '@qtiauth/service-kit';

import { definition, router } from './service.ts';

await runServiceCli(definition, router);
