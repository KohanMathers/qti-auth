#!/usr/bin/env node
import { runServiceCli } from '@qtiauth/service-kit';

import { templatesCheck } from './commands.ts';
import { definition, router } from './service.ts';

await runServiceCli(definition, router, { 'templates check': templatesCheck });
