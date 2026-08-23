// Baseline scenario: normal-day traffic. Establishes the reference
// latency/throughput numbers everything else is compared against.
import { sleep } from 'k6';
import { runCheckout } from './lib/checkout-flow.js';

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1500'],
    checks: ['rate>0.95'],
  },
};

export default function () {
  runCheckout();
  sleep(1);
}
