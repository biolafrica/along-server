const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushMessage {
  to:     string;
  title:  string;
  body:   string;
  data?:  Record<string, string>;
  sound?: 'default';
}

async function sendPush(messages: PushMessage[]): Promise<void> {
  const valid = messages.filter(m => m.to.startsWith('ExponentPushToken'));
  if (valid.length === 0) return;

  // Expo accepts max 100 per request
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

function push(token: string | null | undefined, title: string, body: string, data?: Record<string, string>) {
  if (!token) return Promise.resolve();
  return sendPush([{ to: token, title, body, data, sound: 'default' }]);
}

function pushMany(tokens: (string | null | undefined)[], title: string, body: string, data?: Record<string, string>) {
  return sendPush(
    tokens.filter((t): t is string => !!t).map(to => ({ to, title, body, data, sound: 'default' as const }))
  );
}


export const notifyAccountVerified = (token: string | null, accountType: 'host' | 'rider') =>
  push(token, 'Account verified!',
    accountType === 'host'
      ? 'You\'re verified. Go live to start accepting riders.'
      : 'You\'re verified. Start browsing hosts on your route.',
    { type: 'account_verified' }
  );

export const notifyNewRideRequest = (hostToken: string | null, riderName: string, durationMonths: number) =>
  push(hostToken, 'New ride request',
    `${riderName} wants to ride with you for ${durationMonths} month${durationMonths !== 1 ? 's' : ''}. Tap to review.`,
    { type: 'new_request' }
  );

export const notifyRequestAccepted = (riderToken: string | null, hostName: string) =>
  push(riderToken, '🎉 Request accepted!',
    `${hostName} accepted your request. Your subscription is now active.`,
    { type: 'request_accepted' }
  );

export const notifyRequestDeclined = (riderToken: string | null, hostName: string, reason: 'declined' | 'expired') =>
  push(riderToken, 'Request not accepted',
    reason === 'expired'
      ? `${hostName} didn't respond in time. You've been fully refunded.`
      : `${hostName} couldn't accept your request. You've been fully refunded.`,
    { type: 'request_declined' }
  );

export const notifyPaymentReceived = (riderToken: string | null, amount: number) =>
  push(riderToken, 'Payment confirmed',
    `₦${amount.toLocaleString()} received. Waiting for host to accept your request.`,
    { type: 'payment_confirmed' }
  );

export const notifyRefundIssued = (riderToken: string | null, amount: number) =>
  push(riderToken, 'Refund processed',
    `₦${amount.toLocaleString()} refunded to your card. Allow 3–5 business days.`,
    { type: 'refund_issued' }
  );

export const notifyEarningsCredited = (hostToken: string | null, amount: number, riderName: string) =>
  push(hostToken, 'Earnings credited',
    `₦${amount.toLocaleString()} from ${riderName} has been credited.`,
    { type: 'earnings_credited' }
  );

export const notifyRideReminder = (token: string | null, role: 'host' | 'rider', departureTime: string, pickupStop?: string) =>
  push(token, 'Ride reminder',
    role === 'host'
      ? `You have riders to pick up at ${departureTime}. Confirm pickups in the app.`
      : `Your pickup at ${pickupStop ?? 'your stop'} is at ${departureTime}. Confirm when you're ready.`,
    { type: 'ride_reminder' }
  );

export const notifyRideCompleted = (token: string | null, role: 'host' | 'rider', otherName: string) =>
  push(token, 'Ride completed',
    role === 'host'
      ? `Ride with ${otherName} completed. Don't forget to rate them.`
      : `Ride with ${otherName} completed. Rate your experience!`,
    { type: 'ride_completed' }
  );

export const notifyRenewalReminder = (riderToken: string | null, hostName: string, endDate: string) => {
  const end = new Date(endDate).toLocaleDateString('en-NG', { dateStyle: 'medium' });
  return push(riderToken, '📅 Subscription renewing soon',
    `Your subscription with ${hostName} renews on ${end}.`,
    { type: 'renewal_reminder' }
  );
};

export const notifyHostOnline = (tokens: (string | null | undefined)[], hostName: string, monthlyPrice: number) =>
  pushMany(tokens, 'Host now available',
    `${hostName} just came online — ₦${monthlyPrice.toLocaleString()}/month. Tap to view.`,
    { type: 'host_online' }
  );

export const notifyRenewalCharged = (riderToken: string | null, amount: number, hostName: string) =>
  push(riderToken, 'Subscription renewed',
    `₦${amount.toLocaleString()} charged for your subscription with ${hostName}.`,
    { type: 'renewal_charged' }
  );

export const notifyRenewalFailed = (riderToken: string | null, hostName: string) =>
  push(riderToken, 'Payment failed',
    `We couldn't renew your subscription with ${hostName}. Update your card in the app.`,
    { type: 'renewal_failed' }
  );