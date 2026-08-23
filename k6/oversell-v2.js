// Oversell test v2: same race — many buyers, one low-stock variant — but at
// a concurrency the host can actually serve (the v1 run at 100 VUs saturated
// the box and hit its 1m cap before checkouts could finish, so the lock was
// barely exercised). 40 VUs / 80 attempts / generous time limit means dozens
// of completes genuinely race each other for the 5 units.
import { sleep } from 'k6';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { runCheckout } from './lib/checkout-flow.js';

const LOW_STOCK_VARIANT_ID = __ENV.LOW_STOCK_VARIANT_ID;

const completedForLowStock = new Counter('completed_low_stock_orders');
const rejectedCheckouts = new Counter('rejected_checkouts');

export const options = {
  scenarios: {
    oversell: {
      executor: 'shared-iterations',
      vus: 40,
      iterations: 80,
      maxDuration: '6m',
    },
  },
};

export default function () {
  const result = runCheckout(LOW_STOCK_VARIANT_ID);
  if (result.ok) {
    completedForLowStock.add(1);
    console.log(`VU ${__VU} iter ${__ITER}: ORDER COMPLETED for low-stock variant`);
  } else {
    rejectedCheckouts.add(1);
  }
  sleep(0.1);
}
