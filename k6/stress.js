// Stress scenario: push until error rate spikes or the stack saturates.
// Deliberately uncapped in ambition (arrival-rate executor climbing well
// past "Black Friday" levels) — the point is to find *this environment's*
// real breaking point, not to hit a pre-agreed number.
import { sleep } from 'k6';
import { runCheckout } from './lib/checkout-flow.js';

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 3000,
      stages: [
        { duration: '1m', target: 100 },
        { duration: '2m', target: 500 },
        { duration: '2m', target: 1000 },
        { duration: '2m', target: 2000 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  // no hard thresholds here on purpose — we want the run to complete and
  // show us exactly where things start breaking, not abort early.
};

export default function () {
  runCheckout();
  sleep(0.2);
}
