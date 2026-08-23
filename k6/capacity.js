// Capacity test - open model.
//
// Why this replaces steps.js as the headline test:
//
// steps.js uses `ramping-vus`, a CLOSED model: 50 virtual users each start a
// new checkout only after their last one finished. If the system slows down,
// the load politely slows down with it, so the test can never apply more
// pressure than the system can absorb. That measures latency honestly but it
// cannot find a capacity ceiling, and it is not how Black Friday behaves.
//
// `ramping-arrival-rate` is an OPEN model: N checkouts START every second no
// matter what is happening. Customers arrive whether or not you are ready.
// The rate at which p95 crosses the bar IS the per-node capacity number, and
// that number is what the whole scaling curve is built from.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

const BASE_URL = __ENV.MEDUSA_URL || 'http://localhost:9000';
const PUBLISHABLE_KEY = __ENV.MEDUSA_PUBLISHABLE_KEY;
const REGION_ID = __ENV.MEDUSA_REGION_ID;
const SALES_CHANNEL_ID = __ENV.MEDUSA_SALES_CHANNEL_ID;

const PEAK = parseInt(__ENV.PEAK_RATE || '40', 10);   // checkouts/sec at the top
const NODES = __ENV.NODES || '1';                     // recorded into the summary

const step = {
  browse:             new Trend('step_browse', true),
  create_cart:        new Trend('step_create_cart', true),
  add_item:           new Trend('step_add_item', true),
  addresses:          new Trend('step_addresses', true),
  shipping_options:   new Trend('step_shipping_options', true),   // was never
  shipping_method:    new Trend('step_shipping_method', true),    // measured
  payment_collection: new Trend('step_payment_collection', true),
  payment_session:    new Trend('step_payment_session', true),
  complete:           new Trend('step_complete', true),
};
const checkoutDuration = new Trend('checkout_duration', true);
const completed = new Counter('completed_checkouts');
const abandoned = new Counter('abandoned_checkouts');
const successRate = new Rate('checkout_success');

export const options = {
  scenarios: {
    capacity: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { duration: '1m', target: Math.ceil(PEAK * 0.25) },
        { duration: '2m', target: Math.ceil(PEAK * 0.50) },
        { duration: '2m', target: Math.ceil(PEAK * 0.75) },
        { duration: '3m', target: PEAK },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    // The bar, declared before the run. k6 marks the run failed if we miss it,
    // which is the point - the test is allowed to say no.
    'http_req_duration': ['p(95)<2000'],
    'http_req_failed':   ['rate<0.01'],
    'checkout_success':  ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  tags: { nodes: NODES },
};

const headers = () => ({
  'Content-Type': 'application/json',
  'x-publishable-api-key': PUBLISHABLE_KEY,
});

// Every step records its timing BEFORE deciding whether to bail out, so a
// failed checkout still contributes to the metrics for the steps it reached.
// (The old script returned early and silently, which meant slow configs
// contributed fewer samples to the later steps and looked artificially fast.)
function record(trend, res) {
  trend.add(res.timings.duration);
  return res;
}

export default function () {
  const params = { headers: headers() };
  const t0 = Date.now();
  let ok = false;

  try {
    const list = record(step.browse,
      http.get(`${BASE_URL}/store/products?limit=20&region_id=${REGION_ID}`, params));
    if (!check(list, { 'browse 200': (r) => r.status === 200 })) return;
    const products = (list.json() || {}).products || [];
    if (!products.length) return;
    const variant = products[Math.floor(Math.random() * products.length)].variants?.[0];
    if (!variant) return;

    const cart = record(step.create_cart, http.post(`${BASE_URL}/store/carts`,
      JSON.stringify({ region_id: REGION_ID, sales_channel_id: SALES_CHANNEL_ID }), params));
    if (!check(cart, { 'cart 200': (r) => r.status === 200 })) return;
    const cartId = cart.json().cart.id;

    const line = record(step.add_item, http.post(`${BASE_URL}/store/carts/${cartId}/line-items`,
      JSON.stringify({ variant_id: variant.id, quantity: 1 }), params));
    if (!check(line, { 'line item 200': (r) => r.status === 200 })) return;

    const addr = { first_name: 'Load', last_name: 'Test', address_1: '123 Test St',
                   city: 'Berlin', country_code: 'de', postal_code: '10115' };
    const a = record(step.addresses, http.post(`${BASE_URL}/store/carts/${cartId}`,
      JSON.stringify({ email: `k6+${__VU}_${__ITER}@example.com`,
                       shipping_address: addr, billing_address: addr }), params));
    if (a.status !== 200) return;

    const opts = record(step.shipping_options,
      http.get(`${BASE_URL}/store/shipping-options?cart_id=${cartId}`, params));
    const list2 = (opts.json() || {}).shipping_options || [];
    if (!list2.length) return;
    record(step.shipping_method, http.post(`${BASE_URL}/store/carts/${cartId}/shipping-methods`,
      JSON.stringify({ option_id: list2[0].id }), params));

    const pc = record(step.payment_collection, http.post(`${BASE_URL}/store/payment-collections`,
      JSON.stringify({ cart_id: cartId }), params));
    if (pc.status !== 200) return;
    record(step.payment_session,
      http.post(`${BASE_URL}/store/payment-collections/${pc.json().payment_collection.id}/payment-sessions`,
        JSON.stringify({ provider_id: __ENV.PAYMENT_PROVIDER || 'pp_system_default' }), params));

    const done = record(step.complete,
      http.post(`${BASE_URL}/store/carts/${cartId}/complete`, null, params));
    ok = check(done, { 'complete 200': (r) => r.status === 200 });
    if (ok) { completed.add(1); checkoutDuration.add(Date.now() - t0); }
  } finally {
    successRate.add(ok);
    if (!ok) abandoned.add(1);
  }
}
