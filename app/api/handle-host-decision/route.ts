import { NextRequest, NextResponse } from 'next/server';
import { paystackPost } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import type { DocumentData } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';
import { formatTime } from '@/utils/formatter';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { subscriptionId, decision } = await req.json();

  if (!subscriptionId || !['accept', 'decline'].includes(decision)) {
    return NextResponse.json({ message: 'Invalid parameters' }, { status: 400 });
  }

  const subRef  = db.collection('subscriptions').doc(subscriptionId);
  const subSnap = await dbOperation('firestore_read', 'subscriptions', subscriptionId, () =>
    subRef.get()
  );

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

  const [riderDoc, hostUserDoc, hostProfileDoc] = await Promise.all([
    dbOperation('firestore_read', 'users', sub.rider_id, () =>
      db.collection('users').doc(sub.rider_id).get()
    ),
    dbOperation('firestore_read', 'users', uid, () =>
      db.collection('users').doc(uid).get()
    ),
    dbOperation('firestore_read', 'hosts', uid, () =>
      db.collection('hosts').doc(uid).get()
    ),
  ]);

  const rider       = riderDoc.data();
  const host        = hostUserDoc.data();
  const hostProfile = hostProfileDoc.data();

  // ── Accept ────────────────────────────────────────────────────────────────
  if (decision === 'accept') {

    const capacity = hostProfile?.capacity ?? 2;

    const activeSnap = await db.collection('subscriptions')
    .where('host_id', '==', uid)
    .where('status',  '==', 'active')
    .get();

    if (activeSnap.size >= capacity) {
      return NextResponse.json({
        message: `You've reached your rider capacity (${capacity}). Remove a rider before accepting new requests.`,
        code:    'CAPACITY_REACHED',
      }, { status: 409 });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() + 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + (sub.duration_months ?? 1));

    await dbOperation('firestore_write', 'subscriptions', subscriptionId, () =>
      subRef.update({
        status:      'active',
        accepted_at: new Date().toISOString(),
        start_date:  startDate.toISOString(),
        end_date:    endDate.toISOString(),
      })
    );

    const routeSnap = await db.collection('routes').where('host_id', '==', uid).limit(1).get();
    const routeData = routeSnap.empty ? null : routeSnap.docs[0].data();
    const home      = host?.home_address?.split(',')[0] ?? '—';
    const work      = host?.work_address?.split(',')[0] ?? '—';
    const depTime   = routeData?.departure_time ? formatTime(routeData.departure_time) : '—';
    const period    = new Date().toLocaleString('en-NG', { month: 'long', year: 'numeric' });
    const schedule  = hostProfile?.schedule ?? {};

    const updatedSub = {
      ...sub,
      start_date: startDate.toISOString(),
      end_date:   endDate.toISOString(),
    };
    await createDailyRides(subscriptionId, updatedSub, schedule);

    const chatId = await getOrCreateChat(subscriptionId, uid, sub.rider_id);

    // NON-CRITICAL — enqueue all notifications and emails
    await Promise.all([
      enqueue('send_notification', {
        type:     'request_accepted',
        userId:   sub.rider_id,
        token:    rider?.expo_push_token ?? null,
        hostName: host?.name ?? '',
      }),

      sub.rider_billing_email && enqueue('send_email', {
        type:          'request_accepted',
        to:            sub.rider_billing_email,
        riderName:     rider?.name ?? '',
        hostName:      host?.name  ?? '',
        routeLabel:    `${home} → ${work}`,
        pickupStop:    sub.pickup_stop ?? '—',
        departureTime: depTime,
        carMake:        host?.car_make  ?? "" ,
        carModel:       host?.car_model  ?? "" ,
        carColor:       host?.car_color  ?? "" ,
        carPlate:       host?.car_plate  ?? "" ,
      }),

      // enqueue('send_notification', {
      //   type:      'earnings_credited',
      //   userId:    uid,
      //   token:     host?.expo_push_token ?? null,
      //   amount:    sub.host_earning,
      //   riderName: rider?.name ?? '',
      // }),

      host?.email && enqueue('send_email', {
        type:      'host_payment_notice',
        to:        host.email,
        hostName:  host.name ?? '',
        amount:    sub.host_earning,
        riderName: rider?.name ?? '',
        durationMonths: sub.duration_months
      }),
    ]);

    logger.info('subscription_accepted', {
      subscriptionId, hostId: uid, riderId: sub.rider_id,
    });

    return NextResponse.json({ result: 'accepted', chatId });
  }

  // ── Decline → refund ──────────────────────────────────────────────────────
  const refundRes = await paystackPost('/refund', {
    transaction:   sub.paystack_reference,
    merchant_note: 'Host declined the ride request',
  });

  if (!refundRes.status) {
    logger.error('host_decision_refund_failed', new Error(refundRes.message), {
      subscriptionId, hostId: uid,
    });
    return NextResponse.json({ message: 'Refund failed — contact support' }, { status: 500 });
  }

  await dbOperation('firestore_write', 'subscriptions', subscriptionId, () =>
    subRef.update({
      status:           'rejected',
      refund_reference: refundRes.data?.reference ?? null,
      refunded_at:      new Date().toISOString(),
    })
  );

  await Promise.all([
    enqueue('send_notification', {
      type:     'request_declined',
      userId:   sub.rider_id,
      token:    rider?.expo_push_token ?? null,
      hostName: host?.name ?? '',
      reason:   'declined',
    }),
    enqueue('send_notification', {
      type:   'refund_issued',
      userId: sub.rider_id,
      token:  rider?.expo_push_token ?? null,
      amount: sub.total_amount,
    }),
    sub.rider_billing_email && enqueue('send_email', {
      type:      'request_declined',
      to:        sub.rider_billing_email,
      riderName: rider?.name ?? '',
      hostName:  host?.name  ?? '',
      reason:    'declined',
    }),
    sub.rider_billing_email && enqueue('send_email', {
      type:      'refund',
      to:        sub.rider_billing_email,
      riderName: rider?.name ?? '',
      amount:    sub.total_amount,
      reference: sub.paystack_reference,
      reason:    'Host declined the ride request',
    }),
  ]);

  logger.info('subscription_declined', {
    subscriptionId, hostId: uid, riderId: sub.rider_id,
  });

  return NextResponse.json({ result: 'declined_and_refunded' });
}

async function getOrCreateChat(
  subscriptionId: string,
  hostId:         string,
  riderId:        string,
): Promise<string> {
  const existing = await db.collection('chats')
    .where('subscription_id', '==', subscriptionId)
    .limit(1)
    .get();

  if (!existing.empty) return existing.docs[0].id;

  const chatRef = await db.collection('chats').add({
    subscription_id: subscriptionId,
    host_id:         hostId,
    rider_id:        riderId,
    participants:    [hostId, riderId],
    created_at:      new Date().toISOString(),
    last_message:    null,
    last_message_at: null,
    unread_host:     0,
    unread_rider:    0,
  });

  return chatRef.id;
}

async function createDailyRides(
  subscriptionId: string,
  sub: DocumentData,
  schedule: Record<string, { active: boolean; depart: string; return: string }>,
): Promise<void> {
  const DAY_NAMES  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const BATCH_SIZE = 400;
 
  const start = new Date(sub.start_date);
  const end   = new Date(sub.end_date);
 
  let batch      = db.batch();
  let batchCount = 0;
  let totalCount = 0;
 
  const cursor = new Date(start);
 
  while (cursor <= end) {
    const dayName     = DAY_NAMES[cursor.getDay()];
    const daySchedule = schedule[dayName];
 
    if (daySchedule?.active) {
      const lagosTime = new Date(cursor.getTime() + 60 * 60 * 1000);
      const dateKey   = lagosTime.toISOString().split('T')[0];
      const docId     = `${subscriptionId}_${dateKey}`;
      const docRef    = db.collection('daily_rides').doc(docId);
 
      batch.set(docRef, {
        subscription_id: subscriptionId,
        host_id:         sub.host_id,
        rider_id:        sub.rider_id,
        ride_date:       dateKey,

        pickup_stop:     sub.pickup_stop ?? '',
        depart_time:     daySchedule.depart  ?? '',
        return_time:     daySchedule.return  ?? '',
 
        morning_rider_confirmed:    false,
        morning_rider_confirmed_at: null,
        morning_host_confirmed:     false,
        morning_host_confirmed_at:  null,
        morning_status:             'pending',  // pending | completed | no_show
 
        evening_rider_confirmed:    false,
        evening_rider_confirmed_at: null,
        evening_host_confirmed:     false,
        evening_host_confirmed_at:  null,
        evening_status:             'pending',  // pending | completed | no_show
 
        status:     'pending',
        created_at: new Date().toISOString(),
      }, { merge: true });
 
      batchCount++;
      totalCount++;
 
      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        batch      = db.batch();
        batchCount = 0;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
 
  if (batchCount > 0) await batch.commit();
 
  logger.info('daily_rides_created', { subscriptionId, totalCount });
 
  if (totalCount === 0) {
    logger.warn('daily_rides_zero_created', {
      subscriptionId,
      scheduleKeys: Object.keys(schedule),
    }, 'warning');
  }
}

export const POST = withApiLogging('handle-host-decision', handler as any);