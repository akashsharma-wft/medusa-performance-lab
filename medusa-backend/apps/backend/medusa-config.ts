import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// OPTIMIZED configuration (Phase 6 of the performance lab).
// Baseline ran Medusa's zero-config defaults: in-memory event bus, in-memory
// workflow engine, no cache, in-memory locking, default DB pool.
// This config swaps in the Redis-backed production modules and allows
// server/worker process splitting via MEDUSA_WORKER_MODE.
// Set DISABLE_OPTIMIZATIONS=true to run the original baseline config.

const optimized = process.env.DISABLE_OPTIMIZATIONS !== 'true'
const redisUrl = process.env.REDIS_URL

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    ...(optimized && redisUrl ? { redisUrl } : {}),
    ...(optimized
      ? {
          databaseDriverOptions: {
            pool: {
              min: 2,
              max: parseInt(process.env.DB_POOL_MAX || '40', 10),
            },
          },
        }
      : {}),
    workerMode: (process.env.MEDUSA_WORKER_MODE || 'shared') as
      | 'shared'
      | 'worker'
      | 'server',
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    disable: process.env.DISABLE_MEDUSA_ADMIN === 'true',
  },
  ...(optimized && redisUrl
    ? {
        modules: [
          {
            resolve: '@medusajs/medusa/event-bus-redis',
            options: { redisUrl },
          },
          {
            resolve: '@medusajs/medusa/cache-redis',
            options: { redisUrl },
          },
          {
            resolve: '@medusajs/medusa/workflow-engine-redis',
            options: { redis: { url: redisUrl } },
          },
          {
            resolve: '@medusajs/medusa/locking',
            options: {
              providers: [
                {
                  resolve: '@medusajs/medusa/locking-redis',
                  id: 'locking-redis',
                  is_default: true,
                  options: { redisUrl },
                },
              ],
            },
          },
        ],
      }
    : {}),
})
