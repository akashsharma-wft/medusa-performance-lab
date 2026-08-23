# Test Environment (recorded 2026-07-14)

| Component | Spec |
|---|---|
| Host CPU | AMD Ryzen 7 5800HS, 8 cores / 16 threads |
| Host RAM | 16 GB (15.4 usable) |
| OS | Windows 11 Home |
| Medusa | v2.17.2, production build (`medusa build` + `medusa start`, NODE_ENV=production), running natively on host, port 9000 |
| Node.js | v22.14.0 |
| PostgreSQL | 16.14 (Debian, Docker container, host port 5433) |
| Redis | 7 (Docker container) — present but NOT wired to Medusa in baseline (Medusa default: in-memory event bus, workflow engine, cache, locking) |
| Docker | 28.0.4 (Docker Desktop, WSL2 backend) |
| Monitoring | Prometheus + Grafana + postgres_exporter + redis_exporter + cAdvisor (Docker) |
| Load generator | k6 (runs on same host — k6's own CPU usage tracked during runs to confirm it is not the bottleneck) |

## Catalog
- 205 products (4 demo w/ variants + 200 single-variant load-test products + 1 oversell-test product)
- Oversell-test product: SKU OVERSELL-TEST-1, exactly 5 units in stock
- All other products: 1,000,000 units (stock never exhausts mid-test)
- 1 region (Europe, EUR), 1 stock location, manual fulfillment, system (test) payment provider

## Methodology notes
- k6 drives Medusa's Store API directly (create cart → add item → addresses →
  shipping method → payment session → complete). No storefront UI — a Next.js
  storefront would call these exact endpoints; skipping it removes frontend
  noise from backend measurements.
- Dev server (`medusa develop`) was measured to be 5-10x slower per step than
  the production build; all load tests run against the production build.
- Single-user production-build step timings (smoke test, cold-ish):
  cart create 1.55s, add item 1.85s, addresses 1.14s, shipping method 2.39s,
  payment session 0.21s, complete 2.16s (~9.3s full checkout).
