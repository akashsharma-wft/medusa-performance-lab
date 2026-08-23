// Shared checkout flow used by all k6 scenarios.
// Drives Medusa's Store API directly: list products -> create cart -> add
// line item -> set addresses -> add shipping method -> create payment
// session (manual/test provider) -> complete cart.
//
// This is deliberately API-level (no storefront UI) — see the blog's
// "Methodology" section for why.

import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.MEDUSA_URL || 'http://localhost:9000';
const PUBLISHABLE_KEY = __ENV.MEDUSA_PUBLISHABLE_KEY;
const REGION_ID = __ENV.MEDUSA_REGION_ID;
const SALES_CHANNEL_ID = __ENV.MEDUSA_SALES_CHANNEL_ID;

const jsonHeaders = () => ({
  'Content-Type': 'application/json',
  'x-publishable-api-key': PUBLISHABLE_KEY,
});

// variantId is optional — pass a fixed low-stock variant id for the oversell test.
export function runCheckout(variantId) {
  const params = { headers: jsonHeaders() };

  // 1. Browse products (read path)
  const listRes = http.get(
    `${BASE_URL}/store/products?limit=20&region_id=${REGION_ID}`,
    params
  );
  check(listRes, { 'list products 200': (r) => r.status === 200 });

  let chosenVariantId = variantId;
  if (!chosenVariantId) {
    const body = listRes.json();
    const products = body && body.products ? body.products : [];
    if (products.length === 0) return { ok: false, step: 'browse-empty' };
    const product = products[Math.floor(Math.random() * products.length)];
    if (!product.variants || product.variants.length === 0) {
      return { ok: false, step: 'no-variant' };
    }
    chosenVariantId = product.variants[0].id;
  }

  // 2. Create cart
  const cartRes = http.post(
    `${BASE_URL}/store/carts`,
    JSON.stringify({ region_id: REGION_ID, sales_channel_id: SALES_CHANNEL_ID }),
    params
  );
  const cartOk = check(cartRes, { 'create cart 200': (r) => r.status === 200 });
  if (!cartOk) return { ok: false, step: 'create-cart', status: cartRes.status };
  const cartId = cartRes.json().cart.id;

  // 3. Add line item
  const lineItemRes = http.post(
    `${BASE_URL}/store/carts/${cartId}/line-items`,
    JSON.stringify({ variant_id: chosenVariantId, quantity: 1 }),
    params
  );
  const lineOk = check(lineItemRes, { 'add line item 200': (r) => r.status === 200 });
  if (!lineOk) return { ok: false, step: 'add-line-item', status: lineItemRes.status, body: lineItemRes.body };

  // 4. Set addresses
  const address = {
    first_name: 'Load',
    last_name: 'Test',
    address_1: '123 Test St',
    city: 'Berlin',
    country_code: 'de',
    postal_code: '10115',
  };
  const addrRes = http.post(
    `${BASE_URL}/store/carts/${cartId}`,
    JSON.stringify({ email: `loadtest+${__VU}_${__ITER}@example.com`, shipping_address: address, billing_address: address }),
    params
  );
  const addrOk = check(addrRes, { 'set addresses 200': (r) => r.status === 200 });
  if (!addrOk) {
    console.error(`set-addresses failed: HTTP ${addrRes.status} body=${String(addrRes.body).slice(0, 300)}`);
  }

  // 5. Add shipping method (first available option)
  const optionsRes = http.get(`${BASE_URL}/store/shipping-options?cart_id=${cartId}`, params);
  const options = optionsRes.json() && optionsRes.json().shipping_options;
  if (options && options.length > 0) {
    http.post(
      `${BASE_URL}/store/carts/${cartId}/shipping-methods`,
      JSON.stringify({ option_id: options[0].id }),
      params
    );
  }

  // 6. Initiate payment session (manual/test provider)
  const paymentCollectionRes = http.post(
    `${BASE_URL}/store/payment-collections`,
    JSON.stringify({ cart_id: cartId }),
    params
  );
  if (paymentCollectionRes.status === 200) {
    const pcId = paymentCollectionRes.json().payment_collection.id;
    http.post(
      `${BASE_URL}/store/payment-collections/${pcId}/payment-sessions`,
      JSON.stringify({ provider_id: 'pp_system_default' }),
      params
    );
  }

  // 7. Complete cart -> order
  const completeRes = http.post(`${BASE_URL}/store/carts/${cartId}/complete`, null, params);
  const completeOk = check(completeRes, {
    'complete cart 200': (r) => r.status === 200,
    'order or error handled': (r) => r.status === 200 || r.status === 409,
  });

  return {
    ok: completeOk && completeRes.status === 200,
    status: completeRes.status,
    step: 'complete',
    oversold: completeRes.status === 200,
  };
}
