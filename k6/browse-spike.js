// High-VU browse-only spike: simulates a Black Friday landing wave (users
// browsing the catalog), NOT full checkouts. Kept deliberately minimal so
// each VU's memory footprint stays small enough to run thousands of VUs
// from one machine. Target VU count set via -e SPIKE_VUS.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.MEDUSA_URL || 'http://localhost:9010';
const PK = __ENV.MEDUSA_PUBLISHABLE_KEY;
const REGION_ID = __ENV.MEDUSA_REGION_ID;
const TARGET = parseInt(__ENV.SPIKE_VUS || '1000', 10);

export const options = {
  discardResponseBodies: true,
  scenarios: {
    browse_spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: TARGET },
        { duration: '2m', target: TARGET },
        { duration: '30s', target: 0 },
      ],
    },
  },
};

export default function () {
  const res = http.get(
    `${BASE_URL}/store/products?limit=20&region_id=${REGION_ID}`,
    { headers: { 'x-publishable-api-key': PK } }
  );
  check(res, { 'products 200': (r) => r.status === 200 });
  sleep(1);
}
