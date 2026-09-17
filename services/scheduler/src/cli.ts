#!/usr/bin/env node
import { runServiceCli } from '@qtiauth/service-kit';

import { jobsList } from './commands.ts';
import { definition, router } from './service.ts';

await runServiceCli(definition, router, { 'jobs list': jobsList });
