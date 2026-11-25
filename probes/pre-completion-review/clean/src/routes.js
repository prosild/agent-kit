import { requireAdmin } from './auth.js';

export function register(app, adminRouter, healthRouter) {
  app.use('/health', healthRouter);
  app.use('/admin', requireAdmin, adminRouter);
}
