// Per-step checkout latency under load (50 VUs, optimized topology).
// Same flow as lib/checkout-flow.js but each step records into its own
// Trend metric so the summary reports p95 latency per checkout stage —
// including the payment steps — instead of one aggregate number.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.MEDUSA_URL || 'http://localhost:9020';
const PUBLISHABLE_KEY = __ENV.MEDUSA_PUBLISHABLE_KEY;
const REGION_ID = __ENV.MEDUSA_REGION_ID;
const SALES_CHANNEL_ID = __ENV.MEDUSA_SALES_CHANNEL_ID;

const stepTrends = {
  browse: new Trend('step_browse', true),
  create_cart: new Trend('step_create_cart', true),
  add_item: new Trend('step_add_item', true),
  addresses: new Trend('step_addresses', true),
  shipping: new Trend('step_shipping', true),
  payment_collection: new Trend('step_payment_collection', true),
  payment_session: new Trend('step_payment_session', true),
  complete: new Trend('step_complete', true),
};
const completedCheckouts = new Counter('completed_checkouts');

const jsonHeaders = () => ({
  'Content-Type': 'application/json',
  'x-publishable-api-key': PUBLISHABLE_KEY,
});

export const options = {
  scenarios: {
    steps: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  // thresholds exist so every step metric is always emitted in the summary
  thresholds: {
    step_complete: ['p(95)<60000'],
    step_payment_session: ['p(95)<60000'],
  },
};

export default function () {
  const params = { headers: jsonHeaders() };

  const listRes = http.get(`${BASE_URL}/store/products?limit=20&region_id=${REGION_ID}`, params);
  stepTrends.browse.add(listRes.timings.duration);
  if (!check(listRes, { 'list products 200': (r) => r.status === 200 })) return;
  const products = (listRes.json() || {}).products || [];
  if (products.length === 0) return;
  const product = products[Math.floor(Math.random() * products.length)];
  if (!product.variants || product.variants.length === 0) return;
  const variantId = product.variants[0].id;

  const cartRes = http.post(
    `${BASE_URL}/store/carts`,
    JSON.stringify({ region_id: REGION_ID, sales_channel_id: SALES_CHANNEL_ID }),
    params
  );
  stepTrends.create_cart.add(cartRes.timings.duration);
  if (!check(cartRes, { 'create cart 200': (r) => r.status === 200 })) return;
  const cartId = cartRes.json().cart.id;

  const lineRes = http.post(
    `${BASE_URL}/store/carts/${cartId}/line-items`,
    JSON.stringify({ variant_id: variantId, quantity: 1 }),
    params
  );
  stepTrends.add_item.add(lineRes.timings.duration);
  if (!check(lineRes, { 'add line item 200': (r) => r.status === 200 })) return;

  const address = {
    first_name: 'Load', last_name: 'Test', address_1: '123 Test St',
    city: 'Berlin', country_code: 'de', postal_code: '10115',
  };
  const addrRes = http.post(
    `${BASE_URL}/store/carts/${cartId}`,
    JSON.stringify({ email: `steps+${__VU}_${__ITER}@example.com`, shipping_address: address, billing_address: address }),
    params
  );
  stepTrends.addresses.add(addrRes.timings.duration);
  if (addrRes.status !== 200) return;

  const optionsRes = http.get(`${BASE_URL}/store/shipping-options?cart_id=${cartId}`, params);
  const opts = (optionsRes.json() || {}).shipping_options;
  if (opts && opts.length > 0) {
    const shipRes = http.post(
      `${BASE_URL}/store/carts/${cartId}/shipping-methods`,
      JSON.stringify({ option_id: opts[0].id }),
      params
    );
    stepTrends.shipping.add(shipRes.timings.duration);
  }

  const pcRes = http.post(
    `${BASE_URL}/store/payment-collections`,
    JSON.stringify({ cart_id: cartId }),
    params
  );
  stepTrends.payment_collection.add(pcRes.timings.duration);
  if (pcRes.status === 200) {
    const pcId = pcRes.json().payment_collection.id;
    const psRes = http.post(
      `${BASE_URL}/store/payment-collections/${pcId}/payment-sessions`,
      JSON.stringify({ provider_id: 'pp_system_default' }),
      params
    );
    stepTrends.payment_session.add(psRes.timings.duration);
  }

  const completeRes = http.post(`${BASE_URL}/store/carts/${cartId}/complete`, null, params);
  stepTrends.complete.add(completeRes.timings.duration);
  if (check(completeRes, { 'complete cart 200': (r) => r.status === 200 })) {
    completedCheckouts.add(1);
  }

  sleep(1);
}
