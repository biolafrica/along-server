const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY!;
const BASE_URL = 'https://api.paystack.co';

export async function paystackPost(endpoint: string, body: object) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message ?? 'Paystack request failed');
  }
  return res.json();
}

export async function paystackGet(endpoint: string) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` },
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message ?? 'Paystack request failed');
  }
  return res.json();
}