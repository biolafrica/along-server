const PROJECT_ID = process.env.GCLOUD_PROJECT_ID  ?? '';
const QUEUE_LOC  = process.env.QUEUE_LOCATION     ?? 'europe-west1';
const QUEUE_NAME = process.env.QUEUE_NAME         ?? 'along-jobs';
const WORKER_URL = process.env.WORKER_URL         ?? '';


type SendNotificationPayload =
  | { type: 'account_verified';       userId: string; token: string | null | undefined; accountType: 'host' | 'rider' }
  | { type: 'new_request';            userId: string; token: string | null | undefined; riderName: string; durationMonths: number }
  | { type: 'request_accepted';       userId: string; token: string | null | undefined; hostName: string }
  | { type: 'request_declined';       userId: string; token: string | null | undefined; hostName: string; reason: 'declined' | 'expired' }
  | { type: 'payment_confirmed';      userId: string; token: string | null | undefined; amount: number }
  | { type: 'refund_issued';          userId: string; token: string | null | undefined; amount: number }
  | { type: 'earnings_credited';      userId: string; token: string | null | undefined; amount: number; riderName: string }
  | { type: 'ride_reminder';          userId: string; token: string | null | undefined; role: 'host' | 'rider'; departureTime: string; pickupStop?: string; leg?: 'morning' | 'evening' }
  | { type: 'ride_completed';         userId: string; token: string | null | undefined; role: 'host' | 'rider'; otherName: string }
  | { type: 'renewal_reminder';       userId: string; token: string | null | undefined; hostName: string; endDate: string }
  | { type: 'host_online';            users: { userId: string; token: string | null | undefined }[]; hostName: string; monthlyPrice: number }
  | { type: 'renewal_charged';        userId: string; token: string | null | undefined; amount: number; hostName: string }
  | { type: 'renewal_failed';         userId: string; token: string | null | undefined; hostName: string }
  | { type: 'new_message';            userId: string; token: string | null | undefined; senderName: string; preview: string; chatId: string }
  | { type: 'rider_confirmed_pickup'; userId: string; token: string | null | undefined; riderName: string; pickupStop: string; leg?: 'morning' | 'evening' }
  | { type: 'host_confirmed_pickup';  userId: string; token: string | null | undefined; hostName: string; leg?: 'morning' | 'evening' }
  | { type: 'no_show';                userId: string; token: string | null | undefined; hostName: string; noShowCount: number; maxNoShows: number; leg?: 'morning' | 'evening' }
  | { type: 'bank_account_required';  userId: string; token: string | null | undefined };

type SendEmailPayload =
  | { type: 'welcome';                to: string;   name: string; accountType: 'host' | 'rider' }
  | { type: 'ride_request';           to: string;   hostName: string; riderName: string; pickupStop: string; durationMonths: number; totalAmount: number; deadline: string; gender: string; company:string }
  | { type: 'request_accepted';       to: string;   riderName: string; hostName: string; routeLabel: string; pickupStop: string; departureTime: string; carMake:string; carModel:string; carColor:string; carPlate:string }
  | { type: 'request_declined';       to: string;   riderName: string; hostName: string; reason: 'declined' | 'expired' }
  | { type: 'payment_confirmation';   to: string;   riderName: string; amount: number; reference: string; hostName: string; durationMonths: number }
  | { type: 'host_payment_notice';   to: string;   riderName: string; amount: number;  hostName: string; durationMonths: number }
  | { type: 'refund';                 to: string;   riderName: string; amount: number; reference: string; reason: string }
  | { type: 'earnings_credited';      to: string;   hostName: string; amount: number; riderName: string; period: string }
  | { type: 'renewal_reminder';       to: string;   riderName: string; hostName: string; endDate: string }
  | { type: 'subscription_completed'; to: string;   name: string; role: 'host' | 'rider'; period: string; startDate: string; endDate: string; amount: number }
  | { type: 'host_online';            to: string[]; hostName: string; routeLabel: string; monthlyPrice: number }
  | { type: 'rider_trip_confirmed';   to: string;   riderName: string; hostName: string; pickupStop: string; departureTime: string }
  | { type: 'host_pickup_confirmed';  to: string;   riderName: string; hostName: string }
  | { type: 'no_show';                to: string;   riderName: string; hostName: string; noShowCount: number; maxNoShows: number }
  | { type: 'account_deleted';        to: string;   name: string; };


interface JobPayloadMap {
  send_notification:      SendNotificationPayload;
  send_email:             SendEmailPayload;
  expire_subscription:    { subscriptionId: string };
  cancel_pending_request: { subscriptionId: string };
  send_ride_reminder:     { rideId: string; leg?: 'morning' | 'evening' };
  sync_host_live_status:  { hostId: string };
}

type JobName = keyof JobPayloadMap;


let cachedToken:    string | null = null;
let tokenExpiresAt: number        = 0;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const sa = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON!);

  const header  = { alg: 'RS256', typ: 'JWT' };
  const iat     = Math.floor(now / 1000);
  const jwtPayload = {
    iss:   sa.client_email,
    sub:   sa.client_email,
    aud:   'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-tasks',
    iat,
    exp:   iat + 3600,
  };

  const encodedHeader  = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(jwtPayload));
  const signingInput   = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await importPrivateKey(sa.private_key);
  const signature  = await signJWT(signingInput, privateKey);
  const jwt        = `${signingInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
  }

  const tokenData    = await tokenRes.json();
  cachedToken        = tokenData.access_token;
  tokenExpiresAt     = now + (tokenData.expires_in ?? 3600) * 1000;
  return cachedToken!;
}


function base64url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const der = Buffer.from(pemBody, 'base64');
  return crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
}

async function signJWT(input: string, key: CryptoKey): Promise<string> {
  const encoded   = new TextEncoder().encode(input);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoded);
  return Buffer.from(signature)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}


export async function enqueue<N extends JobName>(
  name: N,
  payload: JobPayloadMap[N],
): Promise<void> {
  if (!WORKER_URL || !PROJECT_ID) {
    console.warn(`[Queue] Missing WORKER_URL or GCLOUD_PROJECT_ID — job '${name}' dropped`);
    return;
  }

  try {
    const accessToken = await getAccessToken();

    const envelope = {
      name,
      payload,
      enqueuedAt: new Date().toISOString(),
    };

    const queuePath = `projects/${PROJECT_ID}/locations/${QUEUE_LOC}/queues/${QUEUE_NAME}`;
    const tasksUrl  = `https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`;

    const res = await fetch(tasksUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        task: {
          httpRequest: {
            httpMethod: 'POST',
            url:         WORKER_URL,
            headers:    {
              'Content-Type':      'application/json',
              'x-internal-secret': process.env.INTERNAL_SECRET ?? '',
            },
            body: Buffer.from(JSON.stringify(envelope)).toString('base64'),
          },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Tasks API ${res.status}: ${errText}`);
    }

    console.log(`[Queue] Enqueued '${name}'`);

  } catch (err: any) {
    console.error(`[Queue] Failed to enqueue '${name}':`, err.message);
  }
}