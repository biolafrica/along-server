// lib/queue.ts  (along-server)

const PROJECT_ID = process.env.GCLOUD_PROJECT_ID  ?? "";
const QUEUE_LOC  = process.env.QUEUE_LOCATION     ?? "europe-west1";
const QUEUE_NAME = process.env.QUEUE_NAME         ?? "along-jobs";
const WORKER_URL = process.env.WORKER_URL         ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// Types — kept in sync with along-functions/src/queue/types.ts
// ─────────────────────────────────────────────────────────────────────────────

type SendNotificationPayload =
  | { type: "account_verified";  userId: string; token: string | null | undefined; accountType: "host" | "rider" }
  | { type: "new_request";       userId: string; token: string | null | undefined; riderName: string; durationMonths: number }
  | { type: "request_accepted";  userId: string; token: string | null | undefined; hostName: string }
  | { type: "request_declined";  userId: string; token: string | null | undefined; hostName: string; reason: "declined" | "expired" }
  | { type: "payment_confirmed"; userId: string; token: string | null | undefined; amount: number }
  | { type: "refund_issued";     userId: string; token: string | null | undefined; amount: number }
  | { type: "earnings_credited"; userId: string; token: string | null | undefined; amount: number; riderName: string }
  | { type: "ride_reminder";     userId: string; token: string | null | undefined; role: "host" | "rider"; departureTime: string; pickupStop?: string }
  | { type: "ride_completed";    userId: string; token: string | null | undefined; role: "host" | "rider"; otherName: string }
  | { type: "renewal_reminder";  userId: string; token: string | null | undefined; hostName: string; endDate: string }
  | { type: "host_online";       users: { userId: string; token: string | null | undefined }[]; hostName: string; monthlyPrice: number }
  | { type: "renewal_charged";   userId: string; token: string | null | undefined; amount: number; hostName: string }
  | { type: "renewal_failed";    userId: string; token: string | null | undefined; hostName: string }
  | { type: "new_message";       userId: string; token: string | null | undefined; senderName: string; preview: string; chatId: string };

type SendEmailPayload =
  | { type: "welcome";                to: string;   name: string; accountType: "host" | "rider" }
  | { type: "ride_request";           to: string;   hostName: string; riderName: string; pickupStop: string; durationMonths: number; totalAmount: number; deadline: string }
  | { type: "request_accepted";       to: string;   riderName: string; hostName: string; routeLabel: string; pickupStop: string; departureTime: string }
  | { type: "request_declined";       to: string;   riderName: string; hostName: string; reason: "declined" | "expired" }
  | { type: "payment_confirmation";   to: string;   riderName: string; amount: number; reference: string; hostName: string; durationMonths: number }
  | { type: "refund";                 to: string;   riderName: string; amount: number; reference: string; reason: string }
  | { type: "earnings_credited";      to: string;   hostName: string; amount: number; riderName: string; period: string }
  | { type: "renewal_reminder";       to: string;   riderName: string; hostName: string; endDate: string }
  | { type: "subscription_completed"; to: string;   name: string; role: "host" | "rider"; period: string; startDate: string; endDate: string; amount: number }
  | { type: "host_online";            to: string[]; hostName: string; routeLabel: string; monthlyPrice: number };

interface JobPayloadMap {
  send_notification:      SendNotificationPayload;
  send_email:             SendEmailPayload;
  expire_subscription:    { subscriptionId: string };
  cancel_pending_request: { subscriptionId: string };
  send_ride_reminder:     { rideId: string };
  sync_host_live_status:  { hostId: string };
}

type JobName = keyof JobPayloadMap;

// ─────────────────────────────────────────────────────────────────────────────
// Build CloudTasksClient options
// - Locally: gcloud auth application-default login provides credentials
// - Vercel: GOOGLE_APPLICATION_CREDENTIALS_JSON env var holds service account JSON
// ─────────────────────────────────────────────────────────────────────────────

function getClientOptions() {
  const credJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (credJson) {
    try {
      const credentials = JSON.parse(credJson);
      return { credentials };
    } catch {
      console.error("[Queue] Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON");
    }
  }
  // Falls back to application default credentials (gcloud auth locally,
  // or Workload Identity on GCP-hosted environments)
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// enqueue
// ─────────────────────────────────────────────────────────────────────────────

export async function enqueue<N extends JobName>(
  name: N,
  payload: JobPayloadMap[N]
): Promise<void> {
  if (!WORKER_URL || !PROJECT_ID) {
    console.warn(`[Queue] Missing WORKER_URL or GCLOUD_PROJECT_ID — job '${name}' dropped`);
    return;
  }

  try {
    const { CloudTasksClient } = await import("@google-cloud/tasks");
    const client    = new CloudTasksClient(getClientOptions());
    const queuePath = client.queuePath(PROJECT_ID, QUEUE_LOC, QUEUE_NAME);

    const envelope = {
      name,
      payload,
      enqueuedAt: new Date().toISOString(),
    };

    const task = {
      httpRequest: {
        httpMethod: "POST" as const,
        url:        WORKER_URL,
        headers:    { "Content-Type": "application/json" },
        body:       Buffer.from(JSON.stringify(envelope)).toString("base64"),
      },
    };

    await client.createTask({ parent: queuePath, task });
    console.log(`[Queue] Enqueued '${name}'`);

  } catch (err: any) {
    console.error(`[Queue] Failed to enqueue '${name}':`, err.message);
  }
}