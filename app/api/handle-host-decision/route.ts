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

    // Fetch both parties
    const [riderDoc, hostDoc] = await Promise.all([
      db.collection('users').doc(sub.rider_id).get(),
      db.collection('users').doc(uid).get(),
    ]);
    const rider = riderDoc.data();
    const host  = hostDoc.data();

    // ── Accept ────────────────────────────────────────────────────────────────
    if (decision === 'accept') {
      await subRef.update({ status: 'active', accepted_at: new Date().toISOString() });

      // Get route for email details
      const routeSnap = await db.collection('routes').where('host_id', '==', uid).limit(1).get();
      const routeData = routeSnap.empty ? null : routeSnap.docs[0].data();
      const home      = host?.home_address?.split(',')[0] ?? '—';
      const work      = host?.work_address?.split(',')[0]  ?? '—';
      const depTime   = routeData?.departure_time ? formatTime(routeData.departure_time) : '—';
      const period    = new Date().toLocaleString('en-NG', { month: 'long', year: 'numeric' });

      console.log(`[handle-host-decision] Subscription ${subscriptionId} accepted. Creating daily rides and sending notifications/emails.`);

      // Create daily_rides for every active day in this subscription period
      // so the schedule tab has data immediately after acceptance.
      await createDailyRides(subscriptionId, sub, hostDoc.data()?.schedule ?? {});

      console.log(`[handle-host-decision] Daily rides created for subscription ${subscriptionId}. Sending notifications and emails.`);

      await Promise.all([
        notifyRequestAccepted(rider?.expo_push_token, host?.name ?? ''),
        sendRequestAcceptedEmail({
          to:            rider?.email ?? sub.rider_billing_email ?? '',
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

      console.log(`[handle-host-decision] Notifications and emails sent for accepted subscription ${subscriptionId}.`);

      return NextResponse.json({ result: 'accepted' });
    }

    // ── Decline → refund ──────────────────────────────────────────────────────
    const refundRes = await paystackPost('/refund', {
      transaction:   sub.paystack_reference,
      merchant_note: 'Host declined the ride request',
    });

    console.log('[handle-host-decision] Refund response:', refundRes);

    if (!refundRes.status) {
      console.error('[handle-host-decision] Refund failed', refundRes);
      return NextResponse.json({ message: 'Refund failed — contact support' }, { status: 500 });
    }

    await subRef.update({
      status:           'rejected',
      refund_reference: refundRes.data?.reference ?? null,
      refunded_at:      new Date().toISOString(),
    });
    console.log(`[handle-host-decision] Subscription ${subscriptionId} marked as rejected with refund reference ${refundRes.data?.reference}`);

    await Promise.all([
      notifyRequestDeclined(rider?.expo_push_token, host?.name ?? '', 'declined'),
      notifyRefundIssued(rider?.expo_push_token, sub.total_amount),
      sendRequestDeclinedEmail({
        to:        host?.email ?? sub.rider_billing_email ?? '',
        riderName: rider?.name ?? '',
        hostName:  host?.name  ?? '',
        reason:    'declined',
      }),
      sendRefundEmail({
        to:        rider?.email ?? sub.rider_billing_email ?? '',
        riderName: rider?.name ?? '',
        amount:    sub.total_amount,
        reference: sub.paystack_reference,
        reason:    'Host declined the ride request',
      }),
    ]);
    console.log(`[handle-host-decision] Notified rider and host about decline and refund for subscription ${subscriptionId}`);

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

// Creates a daily_rides document for every active schedule day
// between subscription start and end dates.
// Document ID: {subscriptionId}_{YYYY-MM-DD}
async function createDailyRides(
  subscriptionId: string,
  sub: DocumentData,
  schedule: Record<string, { active: boolean; depart: string; return: string }>,
): Promise<void> {
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  const start = new Date(sub.start_date);
  const end   = new Date(sub.end_date);
  const batch = db.batch();
  let   count = 0;

  const cursor = new Date(start);
  while (cursor <= end && count < 200) { // cap at 200 docs per batch
    const dayName = DAY_NAMES[cursor.getDay()];
    const daySchedule = schedule[dayName];

    if (daySchedule?.active) {
      const dateKey = cursor.toISOString().split('T')[0]; // YYYY-MM-DD
      const docId   = `${subscriptionId}_${dateKey}`;
      const docRef  = db.collection('daily_rides').doc(docId);

      batch.set(docRef, {
        subscription_id:  subscriptionId,
        host_id:          sub.host_id,
        rider_id:         sub.rider_id,
        ride_date:        dateKey,
        pickup_stop:      sub.pickup_stop ?? '',
        status:           'pending',        // pending → confirmed once both confirm
        rider_confirmed:  false,
        host_confirmed:   false,
        created_at:       new Date().toISOString(),
      }, { merge: true }); // merge so re-runs don't overwrite existing confirmations

      count++;
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  if (count > 0) {
    await batch.commit();
    console.log(`[handle-host-decision] Created ${count} daily_rides for subscription ${subscriptionId}`);
  }
}
