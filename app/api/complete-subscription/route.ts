import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { paystackPost } from '@/lib/paystack';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get('x-internal-secret');
  if (secret !== process.env.INTERNAL_SECRET) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const { subscriptionId } = await req.json();

  if (!subscriptionId) {
    return NextResponse.json({ message: 'Missing subscriptionId' }, { status: 400 });
  }

  const subRef  = db.collection('subscriptions').doc(subscriptionId);
  const subSnap = await dbOperation('firestore_read', 'subscriptions', subscriptionId, () =>
    subRef.get()
  );

  if (!subSnap.exists) {
    return NextResponse.json({ message: 'Subscription not found' }, { status: 404 });
  }

  const sub = subSnap.data()!;

  if (sub.status !== 'active') {
    return NextResponse.json({ message: `Subscription is ${sub.status}, not active` }, { status: 409 });
  }

  // CRITICAL PATH — mark completed first
  await dbOperation('firestore_write', 'subscriptions', subscriptionId, () =>
    subRef.update({
      status:       'completed',
      completed_at: FieldValue.serverTimestamp(),
    })
  );

  const [hostDoc, riderDoc] = await Promise.all([
    dbOperation('firestore_read', 'users', sub.host_id, () =>
      db.collection('users').doc(sub.host_id).get()
    ),
    dbOperation('firestore_read', 'users', sub.rider_id, () =>
      db.collection('users').doc(sub.rider_id).get()
    ),
  ]);

  const host  = hostDoc.data();
  const rider = riderDoc.data();

  const period    = new Date(sub.end_date).toLocaleString('en-NG', { month: 'long', year: 'numeric' });
  const startDate = new Date(sub.start_date).toLocaleDateString('en-NG', { dateStyle: 'long' });
  const endDate   = new Date(sub.end_date).toLocaleDateString('en-NG', { dateStyle: 'long' });

  // NON-CRITICAL — enqueue notifications and emails
  await Promise.all([
    enqueue('send_notification', {
      type: 'ride_completed', userId: sub.rider_id,
      token: rider?.expo_push_token ?? null, role: 'rider',
      otherName: host?.name ?? 'Your host',
    }),
    enqueue('send_notification', {
      type: 'ride_completed', userId: sub.host_id,
      token: host?.expo_push_token ?? null, role: 'host',
      otherName: rider?.name ?? 'Your rider',
    }),
    rider?.email && enqueue('send_email', {
      type: 'subscription_completed', to: rider.email,
      name: rider.name ?? '', role: 'rider',
      period, startDate, endDate, amount: sub.total_amount,
    }),
    host?.email && enqueue('send_email', {
      type: 'subscription_completed', to: host.email,
      name: host.name ?? '', role: 'host',
      period, startDate, endDate, amount: sub.host_earning,
    }),
  ]);

  //Paystack transfer to host
  if (!host?.paystack_recipient_code) {
    logger.warn('complete_subscription_no_recipient_code', {
      subscriptionId, hostId: sub.host_id,
    }, 'warning');
    return NextResponse.json({ result: 'completed_no_transfer', reason: 'no_recipient_code' });
  }

  const reference   = `along_payout_${subscriptionId}_${Date.now()}`;
  const transferRes = await paystackPost('/transfer', {
    source:    'balance',
    amount:    sub.host_earning * 100,
    recipient: host.paystack_recipient_code,
    reason:    `Along earnings — ${period}`,
    reference,
    currency:  'NGN',
  });

  if (!transferRes.status) {
    logger.error('complete_subscription_transfer_failed', new Error(transferRes.message), {
      subscriptionId, hostId: sub.host_id, reference,
    });
    await dbOperation('firestore_write', 'subscriptions', subscriptionId, () =>
      subRef.update({ transfer_status: 'failed', transfer_error: transferRes.message })
    );
    return NextResponse.json({ result: 'completed_transfer_failed', error: transferRes.message });
  }

  await dbOperation('firestore_write', 'subscriptions', subscriptionId, () =>
    subRef.update({
      transfer_code:         transferRes.data?.transfer_code ?? null,
      transfer_reference:    reference,
      transfer_status:       transferRes.data?.status ?? 'pending',
      transfer_initiated_at: FieldValue.serverTimestamp(),
    })
  );

  // transfer.success webhook fires earnings_credited notification once Paystack confirms
  logger.info('subscription_completed', {
    subscriptionId, hostId: sub.host_id, riderId: sub.rider_id, reference,
  });

  return NextResponse.json({ result: 'completed_and_transferred', reference });
}

export const POST = withApiLogging('complete-subscription', handler as any);