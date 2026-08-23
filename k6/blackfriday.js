// "Black Friday" scenario: sustained high concurrency.
import { sleep } from 'k6';
import { runCheckout } from './lib/checkout-flow.js';

export const options = {
  scenarios: {
    black_friday: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 300 },
        { duration: '3m', target: 300 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
  },
};

export default function () {
  runCheckout();
  sleep(0.5);
}
