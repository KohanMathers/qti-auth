import { createApp } from './app.js';
import { handleScheduled } from './cron.js';

const app = createApp();

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
