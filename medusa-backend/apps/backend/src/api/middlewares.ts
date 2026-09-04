import {
  defineMiddlewares,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

// Response cache for the product listing.
//
// Medusa's `cache-redis` module is an INTERNAL service -- it caches things like
// price calculations, not Store API responses. Nothing caches GET
// /store/products out of the box, so every browse hits Postgres and fans out
// into ~200 queries for variants, prices and options.
//
// Browse is pure read traffic and is exactly what a CDN absorbs in production.
// Caching it here is the single cheapest win available: it removes the most
// query-expensive request in the checkout flow from the database path entirely.
//
// TTL is deliberately short. Catalogue data changes rarely during a sale, but a
// stale price is a real problem, so 60s bounds the damage.
const TTL_SECONDS = parseInt(process.env.PRODUCT_CACHE_TTL || "60", 10)
const ENABLED = process.env.DISABLE_PRODUCT_CACHE !== "true"

async function cacheProductList(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  if (!ENABLED) {
    res.setHeader("x-cache", "OFF")
    return next()
  }

  let cache: any
  try {
    cache = req.scope.resolve(Modules.CACHE)
  } catch {
    return next() // no cache module wired (default config) - behave as before
  }

  // The query string IS the cache key: different region, limit or field
  // selection are different responses.
  const key = `storecache:products:${req.url}`

  try {
    const hit = await cache.get(key)
    if (hit) {
      res.setHeader("x-cache", "HIT")
      return res.json(hit)
    }
  } catch {
    // a cache read failure must never fail the request
  }

  const originalJson = res.json.bind(res)
  ;(res as any).json = (body: unknown) => {
    // Fire-and-forget: the customer should not wait on the cache write.
    Promise.resolve(cache.set(key, body, TTL_SECONDS)).catch(() => {})
    res.setHeader("x-cache", "MISS")
    return originalJson(body)
  }

  return next()
}

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/products",
      method: "GET",
      middlewares: [cacheProductList],
    },
  ],
})
