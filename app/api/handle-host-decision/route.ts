import { NextRequest, NextResponse } from 'next/server';
import { paystackPost } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import type { DocumentData } from 'firebase-admin/firestore';
import {
  sendRequestAcceptedEmail,
  sendRequestDeclinedEmail,
  sendRefundEmail,
  sendEarningsCreditedEmail,
} from '@/lib/email';
import {
  notifyRequestAccepted,
  notifyRequestDeclined,
  notifyRefundIssued,
  notifyEarningsCredited,
} from '@/lib/notification';

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { subscriptionId, decision } = await req.json();

    if (!subscriptionId || !['accept', 'decline'].includes(decision)) {
      return NextResponse.json({ message: 'Invalid parameters' }, { status: 400 });
    }

    const subRef  = db.collection('subscriptions').doc(subscriptionId);
    const subSnap = await subRef.get();

    if (!subSnap.exists) {
      return NextResponse.json({ message: 'Subscription not found' }, { status: 404 });
    }

    const sub = subSnap.data()!;

    if (sub.host_id !== uid) {
      return NextResponse.json({ message: 'Only the host can respond to this request' }, { status: 403 });
    }
    if (sub.status !== 'pending') {
      return NextResponse.json({ message: 'Subscription is no longer pending' }, { status: 409 });
    }

    // Fetch both parties + host profile doc (schedule lives on hosts/, not users/)
    const [riderDoc, hostUserDoc, hostProfileDoc] = await Promise.all([
      db.collection('users').doc(sub.rider_id).get(),
      db.collection('users').doc(uid).get(),
      db.collection('hosts').doc(uid).get(),           // ← schedule is here
    ]);
    const rider       = riderDoc.data();
    const host        = hostUserDoc.data();
    const hostProfile = hostProfileDoc.data();

    // ── Accept ────────────────────────────────────────────────────────────────
    if (decision === 'accept') {
      // Start date = tomorrow — gives the rider time to prepare and ensures
      // no daily_rides are created for a day that's already in progress.
      const startDate = new Date();
      startDate.setDate(startDate.getDate() + 1);
      startDate.setHours(0, 0, 0, 0);

      const endDate = new Date(startDate);
      endDate.setMonth(endDate.getMonth() + (sub.duration_months ?? 1));

      await subRef.update({
        status:      'active',
        accepted_at: new Date().toISOString(),
        start_date:  startDate.toISOString(),
        end_date:    endDate.toISOString(),
      });

      // Get route for email details
      const routeSnap = await db.collection('routes').where('host_id', '==', uid).limit(1).get();
      const routeData = routeSnap.empty ? null : routeSnap.docs[0].data();
      const home      = host?.home_address?.split(',')[0] ?? '—';
      const work      = host?.work_address?.split(',')[0]  ?? '—';
      const depTime   = routeData?.departure_time ? formatTime(routeData.departure_time) : '—';
      const period    = new Date().toLocaleString('en-NG', { month: 'long', year: 'numeric' });

      // Schedule comes from the hosts doc — this was the bug
      const schedule  = hostProfile?.schedule ?? {};

      console.log('[handle-host-decision] Schedule keys:', Object.keys(schedule));
      console.log('[handle-host-decision] Active days:', Object.entries(schedule).filter(([, d]: any) => d.active).map(([k]) => k));

      // Create daily_rides from tomorrow through end date
      const updatedSub = {
        ...sub,
        start_date: startDate.toISOString(),
        end_date:   endDate.toISOString(),
      };
      await createDailyRides(subscriptionId, updatedSub, schedule);

      // Create or find existing chat for this subscription
      const chatId = await getOrCreateChat(subscriptionId, uid, sub.rider_id);

      await Promise.all([
        notifyRequestAccepted(rider?.expo_push_token, host?.name ?? ''),
        sendRequestAcceptedEmail({
          to:            sub.rider_billing_email,
          riderName:     rider?.name ?? '',
          hostName:      host?.name  ?? '',
          routeLabel:    `${home} → ${work}`,
          pickupStop:    sub.pickup_stop ?? '—',
          departureTime: depTime,
        }),
        notifyEarningsCredited(host?.expo_push_token, sub.host_earning, rider?.name ?? ''),
        sendEarningsCreditedEmail({
          to:        host?.email ?? '',
          hostName:  host?.name ?? '',
          amount:    sub.host_earning,
          riderName: rider?.name ?? '',
          period,
        }),
      ]);

      return NextResponse.json({ result: 'accepted', chatId });
    }

    // ── Decline → refund ──────────────────────────────────────────────────────
    const refundRes = await paystackPost('/refund', {
      transaction:   sub.paystack_reference,
      merchant_note: 'Host declined the ride request',
    });

    if (!refundRes.status) {
      console.error('[handle-host-decision] Refund failed', refundRes);
      return NextResponse.json({ message: 'Refund failed — contact support' }, { status: 500 });
    }

    await subRef.update({
      status:           'rejected',
      refund_reference: refundRes.data?.reference ?? null,
      refunded_at:      new Date().toISOString(),
    });

    await Promise.all([
      notifyRequestDeclined(rider?.expo_push_token, host?.name ?? '', 'declined'),
      notifyRefundIssued(rider?.expo_push_token, sub.total_amount),
      sendRequestDeclinedEmail({
        to:        sub.rider_billing_email,
        riderName: rider?.name ?? '',
        hostName:  host?.name  ?? '',
        reason:    'declined',
      }),
      sendRefundEmail({
        to:        sub.rider_billing_email,
        riderName: rider?.name ?? '',
        amount:    sub.total_amount,
        reference: sub.paystack_reference,
        reason:    'Host declined the ride request',
      }),
    ]);

    return NextResponse.json({ result: 'declined_and_refunded' });

  } catch (err: any) {
    console.error('[handle-host-decision]', err);
    const status = err.message?.includes('Authorization') ? 401 : 500;
    return NextResponse.json({ message: err.message }, { status });
  }
}

function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${period}`;
}

// Returns the chatId for this subscription's conversation.
// Creates a new chat document if one doesn't exist yet.
// Keyed by subscription_id so retries are idempotent and
// each subscription gets its own conversation thread.
async function getOrCreateChat(
  subscriptionId: string,
  hostId:         string,
  riderId:        string,
): Promise<string> {
  // Check if a chat already exists for this subscription
  const existing = await db.collection('chats')
    .where('subscription_id', '==', subscriptionId)
    .limit(1)
    .get();

  if (!existing.empty) {
    return existing.docs[0].id;
  }

  // Create a new chat
  const chatRef = await db.collection('chats').add({
    subscription_id: subscriptionId,
    host_id:         hostId,
    rider_id:        riderId,
    participants:    [hostId, riderId],   // array for easy querying
    created_at:      new Date().toISOString(),
    last_message:    null,
    last_message_at: null,
    unread_host:     0,
    unread_rider:    0,
  });

  return chatRef.id;
}

// Creates a daily_rides document for every active schedule day
// between subscription start and end dates.
// Document ID: {subscriptionId}_{YYYY-MM-DD}
// Handles multi-batch writes for subscriptions longer than ~166 active days.
async function createDailyRides(
  subscriptionId: string,
  sub: DocumentData,
  schedule: Record<string, { active: boolean; depart: string; return: string }>,
): Promise<void> {
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const BATCH_SIZE = 400; // Firestore max is 500, leave headroom

  const start = new Date(sub.start_date);
  const end   = new Date(sub.end_date);

  let batch     = db.batch();
  let batchCount = 0;
  let totalCount = 0;

  const cursor = new Date(start);

  while (cursor <= end) {
    const dayName     = DAY_NAMES[cursor.getDay()];
    const daySchedule = schedule[dayName];

    if (daySchedule?.active) {
      // Use Lagos local date (UTC+1) rather than UTC date to avoid
      // off-by-one errors when server runs in UTC
      const lagosOffset = 60; // minutes
      const lagosTime   = new Date(cursor.getTime() + lagosOffset * 60 * 1000);
      const dateKey     = lagosTime.toISOString().split('T')[0]; // YYYY-MM-DD in Lagos time

      const docId  = `${subscriptionId}_${dateKey}`;
      const docRef = db.collection('daily_rides').doc(docId);

      batch.set(docRef, {
        subscription_id: subscriptionId,
        host_id:         sub.host_id,
        rider_id:        sub.rider_id,
        ride_date:       dateKey,
        pickup_stop:     sub.pickup_stop ?? '',
        status:          'pending',
        rider_confirmed: false,
        host_confirmed:  false,
        created_at:      new Date().toISOString(),
      }, { merge: true }); // merge preserves any existing confirmations on retry

      batchCount++;
      totalCount++;

      // Commit and start a fresh batch when approaching the limit
      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        batch      = db.batch();
        batchCount = 0;
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  // Commit any remaining writes
  if (batchCount > 0) {
    await batch.commit();
  }

  console.log(`[createDailyRides] Created ${totalCount} daily_rides for subscription ${subscriptionId}`);
  if (totalCount === 0) {
    console.warn(`[createDailyRides] Zero docs created — schedule may be empty or all days inactive. Schedule:`, JSON.stringify(schedule));
  }
}
