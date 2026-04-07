import { NextRequest, NextResponse } from 'next/server';
import { paystackPost } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
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

  if (sub.rider_id !== uid) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 403 });
  }

  if (sub.status !== 'pending') {
    return NextResponse.json({
      message: sub.status === 'active'
        ? 'Active subscriptions cannot be cancelled here. Contact support.'
        : 'This request is no longer pending.',
    }, { status: 409 });
  }

  // CRITICAL PATH — refund first
  const refundRes = await paystackPost('/refund', {
    transaction:   sub.paystack_reference,
    merchant_note: 'Rider cancelled their ride request',
  });

  if (!refundRes.status) {
    logger.error('cancel_request_refund_failed', new Error(refundRes.message), {
      subscriptionId,
      riderId: uid,
    });
    return NextResponse.json({ message: 'Refund failed — please contact support' }, { status: 500 });
  }

  await dbOperation('firestore_write', 'subscriptions', subscriptionId, () =>
    subRef.update({
      status:           'cancelled',
      refund_reference: refundRes.data?.reference ?? null,
      cancelled_at:     new Date().toISOString(),
      refunded_at:      new Date().toISOString(),
    })
  );

  const riderDoc = await dbOperation('firestore_read', 'users', uid, () =>
    db.collection('users').doc(uid).get()
  );
  const rider = riderDoc.data();

  // NON-CRITICAL — enqueue
  await Promise.all([
    enqueue('send_notification', {
      type:   'refund_issued',
      userId: uid,
      token:  rider?.expo_push_token ?? null,
      amount: sub.total_amount,
    }),
    sub.rider_billing_email && enqueue('send_email', {
      type:      'refund',
      to:        sub.rider_billing_email,
      riderName: rider?.name ?? '',
      amount:    sub.total_amount,
      reference: sub.paystack_reference,
      reason:    'You cancelled your ride request',
    }),
  ]);

  logger.info('request_cancelled', { subscriptionId, riderId: uid, amount: sub.total_amount });
  return NextResponse.json({ result: 'cancelled_and_refunded' });
}

export const POST = withApiLogging('cancel-request', handler as any);