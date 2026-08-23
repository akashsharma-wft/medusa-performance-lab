// Oversell / race-condition test: many concurrent VUs all try to buy the
// SAME low-stock variant at once. Verifies Medusa's inventory reservation
// (the workflow compensation mechanism from the earlier "Medusa Workflows"
// blog) actually prevents overselling under real contention, rather than
// just claiming to in docs.
import { sleep } from 'k6';
import { runCheckout } from './lib/checkout-flow.js';

const LOW_STOCK_VARIANT_ID = __ENV.LOW_STOCK_VARIANT_ID;
const LOW_STOCK_QTY = parseInt(__ENV.LOW_STOCK_QTY || '5', 10);

export const options = {
  scenarios: {
    oversell: {
      executor: 'shared-iterations',
      vus: Math.max(50, LOW_STOCK_QTY * 20),
      iterations: Math.max(100, LOW_STOCK_QTY * 20),
      maxDuration: '1m',
    },
  },
};

export default function () {
  const result = runCheckout(LOW_STOCK_VARIANT_ID);
  if (result.oversold) {
    console.log(`VU ${__VU} iter ${__ITER}: order completed for low-stock variant`);
  }
  sleep(0.1);
}

// After the run: compare successful-order count (from k6 summary "oversold"
// custom tag / logs) against LOW_STOCK_QTY. successes > qty === overselling
// actually occurred and Medusa's reservation failed under contention.
