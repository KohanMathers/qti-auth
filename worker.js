import { createApp } from './src/app.js';
import { handleScheduled } from './src/cron.js';

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
