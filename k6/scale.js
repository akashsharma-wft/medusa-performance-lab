// Scaling curve: fixed concurrency, measure throughput. Run identically at
// 1, 2 and 3 nodes; the slope of completed-checkouts vs node count IS the
// answer to "can Medusa handle Black Friday".
//
// Why closed-model (constant VUs) rather than the arrival-rate model in
// capacity.js: a 2-core node saturates at roughly 0.2 checkouts/sec, so any
// open-model arrival rate above that makes the queue grow without bound and
// every request hits the 60s timeout -- you get "everything failed" instead of
// a number. A fixed pool of virtual users self-regulates: each one waits for
// its checkout before starting the next, so the system is pushed to saturation
// and held there, and throughput becomes a clean measurement.
//
// Open-model still matters for finding a ceiling. It is the wrong tool for
// comparing configurations, which is what the curve needs.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.MEDUSA_URL || 'http://localhost:9000';
const PK = __ENV.MEDUSA_PUBLISHABLE_KEY;
const REGION_ID = __ENV.MEDUSA_REGION_ID;
const SALES_CHANNEL_ID = __ENV.MEDUSA_SALES_CHANNEL_ID;

const VUS = parseInt(__ENV.VUS || '10', 10);
const DURATION = __ENV.DURATION || '4m';

// Field selection for the product listing.
//
// By default Medusa returns every field on every product, which fans out into
// separate queries for variants, prices, options and option values -- the bulk
// of the ~404 queries a single checkout costs. The storefront only needs a
// variant id to build a cart, so LEAN=true asks for exactly that. This is a
// client-side change: no Medusa code involved, just a better question.
const LEAN = __ENV.LEAN === 'true';
const PRODUCT_QS = LEAN
  ? `limit=20&region_id=${REGION_ID}&fields=id,title,*variants.id`
  : `limit=20&region_id=${REGION_ID}`;

const step = {
  browse:             new Trend('step_browse', true),
  create_cart:        new Trend('step_create_cart', true),
  add_item:           new Trend('step_add_item', true),
  addresses:          new Trend('step_addresses', true),
  shipping_options:   new Trend('step_shipping_options', true),
  shipping_method:    new Trend('step_shipping_method', true),
  payment_collection: new Trend('step_payment_collection', true),
  payment_session:    new Trend('step_payment_session', true),
  complete:           new Trend('step_complete', true),
};
const checkoutDuration = new Trend('checkout_duration', true);
const completed = new Counter('completed_checkouts');
const failed = new Counter('failed_checkouts');
const successRate = new Rate('checkout_success');

export const options = {
  scenarios: {
    scale: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '45s',
    },
  },
  thresholds: {
    // Declared, not enforced with abortOnFail: a missed bar is a result we
    // report, not a reason to throw the run away.
    'http_req_duration': ['p(95)<2000'],
    'http_req_failed':   ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: { nodes: __ENV.NODES || '1', lean: __ENV.LEAN || 'false' },
};

const H = () => ({ headers: { 'Content-Type': 'application/json', 'x-publishable-api-key': PK } });
const rec = (t, r) => { t.add(r.timings.duration); return r; };
// A timed-out request has no body and res.json() throws on null.
const body = (r) => { if (!r || r.status === 0 || !r.body) return null;
                      try { return r.json(); } catch (e) { return null; } };

export default function () {
  const p = H();
  const t0 = Date.now();
  let ok = false;

  try {
    const list = rec(step.browse, http.get(`${BASE_URL}/store/products?${PRODUCT_QS}`, p));
    if (!check(list, { browse: (r) => r.status === 200 })) return;
    const variant = ((body(list) || {}).products || [])[Math.floor(Math.random() * 20)]?.variants?.[0];
    if (!variant) return;

    const cart = rec(step.create_cart, http.post(`${BASE_URL}/store/carts`,
      JSON.stringify({ region_id: REGION_ID, sales_channel_id: SALES_CHANNEL_ID }), p));
    if (!check(cart, { cart: (r) => r.status === 200 })) return;
    const cj = body(cart); if (!cj || !cj.cart) return;
    const id = cj.cart.id;

    if (!check(rec(step.add_item, http.post(`${BASE_URL}/store/carts/${id}/line-items`,
        JSON.stringify({ variant_id: variant.id, quantity: 1 }), p)),
        { 'line item': (r) => r.status === 200 })) return;

    const a = { first_name: 'Load', last_name: 'Test', address_1: '1 Test St',
                city: 'Berlin', country_code: 'de', postal_code: '10115' };
    if (rec(step.addresses, http.post(`${BASE_URL}/store/carts/${id}`,
        JSON.stringify({ email: `k6+${__VU}_${__ITER}@example.com`,
                         shipping_address: a, billing_address: a }), p)).status !== 200) return;

    const so = rec(step.shipping_options, http.get(`${BASE_URL}/store/shipping-options?cart_id=${id}`, p));
    const opt = ((body(so) || {}).shipping_options || [])[0];
    if (!opt) return;
    rec(step.shipping_method, http.post(`${BASE_URL}/store/carts/${id}/shipping-methods`,
      JSON.stringify({ option_id: opt.id }), p));

    const pc = rec(step.payment_collection, http.post(`${BASE_URL}/store/payment-collections`,
      JSON.stringify({ cart_id: id }), p));
    const pcj = body(pc);
    if (pc.status !== 200 || !pcj || !pcj.payment_collection) return;
    rec(step.payment_session, http.post(
      `${BASE_URL}/store/payment-collections/${pcj.payment_collection.id}/payment-sessions`,
      JSON.stringify({ provider_id: 'pp_system_default' }), p));

    const done = rec(step.complete, http.post(`${BASE_URL}/store/carts/${id}/complete`, null, p));
    ok = check(done, { complete: (r) => r.status === 200 });
    if (ok) { completed.add(1); checkoutDuration.add(Date.now() - t0); }
  } finally {
    successRate.add(ok);
    if (!ok) failed.add(1);
  }
}
