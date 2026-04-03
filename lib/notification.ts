import { db } from './firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushMessage {
  to:    string;
  title: string;
  body:  string;
  data:  Record<string, string>;
  sound: 'default';
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

async function sendPush(messages: PushMessage[]): Promise<void> {
  const valid = messages.filter(m => m.to.startsWith('ExponentPushToken'));
  if (valid.length === 0) return;
  for (let i = 0; i < valid.length; i += 100) {
    try {
      await fetch(EXPO_PUSH_URL, {
        method:  'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body:    JSON.stringify(valid.slice(i, i + 100)),
      });
    } catch (err: any) {
      console.error('[push] Failed:', err.message);
    }
  }
}

// Writes one notification to Firestore AND sends a push if token is provided.
// The Firestore record powers the in-app notification list.
// The push token is optional — if null/undefined, only the Firestore record is written.
async function notify(params: {
  userId: string;
  token:  string | null | undefined;
  title:  string;
  body:   string;
  type:   string;
  url:    string;
}): Promise<void> {
  const { userId, token, title, body, type, url } = params;

  // Always write to Firestore — this is the source of truth for the notification list
  await db.collection('notifications').add({
    user_id:    userId,
    type,
    title,
    body,
    url,
    read:       false,
    created_at: FieldValue.serverTimestamp(),
  });

  // Send push if token available
  if (token?.startsWith('ExponentPushToken')) {
    await sendPush([{ to: token, title, body, data: { type, url }, sound: 'default' }]);
  }
}

// Broadcast to many users — one Firestore write + one push per user
async function notifyMany(params: {
  users:  { userId: string; token: string | null | undefined }[];
  title:  string;
  body:   string;
  type:   string;
  url:    string;
}): Promise<void> {
  const { users, title, body, type, url } = params;

  await Promise.all(users.map(u => notify({ userId: u.userId, token: u.token, title, body, type, url })));
}


export const notifyAccountVerified = (userId: string, token: string | null, accountType: 'host' | 'rider') =>
  notify({
    userId, token,
    title: 'Account verified!',
    body:  accountType === 'host'
      ? "You're verified. Go live to start accepting riders."
      : "You're verified. Start browsing hosts on your route.",
    type: 'account_verified',
    url:  '/(tabs)',
  });

export const notifyNewRideRequest = (userId: string, hostToken: string | null, riderName: string, durationMonths: number) =>
  notify({
    userId, token: hostToken,
    title: 'New ride request',
    body:  `${riderName} wants to ride with you for ${durationMonths} month${durationMonths !== 1 ? 's' : ''}. Tap to review.`,
    type:  'new_request',
    url:   '/(tabs)/rides',
  });

export const notifyRequestAccepted = (userId: string, riderToken: string | null, hostName: string) =>
  notify({
    userId, token: riderToken,
    title: '🎉 Request accepted!',
    body:  `${hostName} accepted your request. Your subscription is now active.`,
    type:  'request_accepted',
    url:   '/(tabs)/rides',
  });

export const notifyRequestDeclined = (userId: string, riderToken: string | null, hostName: string, reason: 'declined' | 'expired') =>
  notify({
    userId, token: riderToken,
    title: 'Request not accepted',
    body:  reason === 'expired'
      ? `${hostName} didn't respond in time. You've been fully refunded.`
      : `${hostName} couldn't accept your request. You've been fully refunded.`,
    type: 'request_declined',
    url:  '/(tabs)/rides',
  });

export const notifyPaymentReceived = (userId: string, riderToken: string | null, amount: number) =>
  notify({
    userId, token: riderToken,
    title: 'Payment confirmed',
    body:  `₦${amount.toLocaleString()} received. Waiting for host to accept your request.`,
    type:  'payment_confirmed',
    url:   '/(tabs)/rides',
  });

export const notifyRefundIssued = (userId: string, riderToken: string | null, amount: number) =>
  notify({
    userId, token: riderToken,
    title: 'Refund processed',
    body:  `₦${amount.toLocaleString()} refunded to your card. Allow 3–5 business days.`,
    type:  'refund_issued',
    url:   '/(tabs)',
  });

export const notifyEarningsCredited = (userId: string, hostToken: string | null, amount: number, riderName: string) =>
  notify({
    userId, token: hostToken,
    title: 'Earnings credited',
    body:  `₦${amount.toLocaleString()} from ${riderName} has been credited.`,
    type:  'earnings_credited',
    url:   '/(tabs)/rides',
  });

export const notifyRideReminder = (userId: string, token: string | null, role: 'host' | 'rider', departureTime: string, pickupStop?: string) =>
  notify({
    userId, token,
    title: 'Ride reminder',
    body:  role === 'host'
      ? `You have riders to pick up at ${departureTime}.`
      : `Your pickup at ${pickupStop ?? 'your stop'} is at ${departureTime}.`,
    type: 'ride_reminder',
    url:  '/(tabs)/rides',
  });

export const notifyRideCompleted = (userId: string, token: string | null, role: 'host' | 'rider', otherName: string) =>
  notify({
    userId, token,
    title: 'Ride completed',
    body:  role === 'host'
      ? `Ride with ${otherName} completed. Don't forget to rate them.`
      : `Ride with ${otherName} completed. Rate your experience!`,
    type: 'ride_completed',
    url:  '/(tabs)/rides',
  });

export const notifyRenewalReminder = (userId: string, riderToken: string | null, hostName: string, endDate: string) => {
  const end = new Date(endDate).toLocaleDateString('en-NG', { dateStyle: 'medium' });
  return notify({
    userId, token: riderToken,
    title: 'Subscription renewing soon',
    body:  `Your subscription with ${hostName} renews on ${end}.`,
    type:  'renewal_reminder',
    url:   '/(tabs)',
  });
};

export const notifyHostOnline = (users: { userId: string; token: string | null | undefined }[], hostName: string, monthlyPrice: number) =>
  notifyMany({
    users,
    title: 'Host now available',
    body:  `${hostName} just came online — ₦${monthlyPrice.toLocaleString()}/month. Tap to view.`,
    type:  'host_online',
    url:   '/(tabs)/rides',
  });

export const notifyRenewalCharged = (userId: string, riderToken: string | null, amount: number, hostName: string) =>
  notify({
    userId, token: riderToken,
    title: 'Subscription renewed',
    body:  `₦${amount.toLocaleString()} charged for your subscription with ${hostName}.`,
    type:  'renewal_charged',
    url:   '/(tabs)',
  });

export const notifyRenewalFailed = (userId: string, riderToken: string | null, hostName: string) =>
  notify({
    userId, token: riderToken,
    title: 'Payment failed',
    body:  `We couldn't renew your subscription with ${hostName}. Update your card in the app.`,
    type:  'renewal_failed',
    url:   '/(tabs)/profile',
  });

export const notifyNewMessage = (userId: string, token: string | null, senderName: string, preview: string, chatId: string) =>
  notify({
    userId, token,
    title: senderName,
    body:  preview,
    type:  'new_message',
    url:   `/chat/${chatId}`,
  });