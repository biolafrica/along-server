import { NextRequest, NextResponse } from 'next/server';
import { paystackPost } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { sendRefundEmail } from '@/lib/email';
import { notifyRefundIssued } from '@/lib/notification';

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { subscriptionId } = await req.json();

    if (!subscriptionId) {
      return NextResponse.json({ message: 'Missing subscriptionId' }, { status: 400 });
    }

    const subRef  = db.collection('subscriptions').doc(subscriptionId);
    const subSnap = await subRef.get();

    if (!subSnap.exists) {
      return NextResponse.json({ message: 'Subscription not found' }, { status: 404 });
    }

    const sub = subSnap.data()!;

    // Only the rider can cancel their own request
    if (sub.rider_id !== uid) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 403 });
    }

    // Can only cancel pending requests — active subscriptions have a different flow
    if (sub.status !== 'pending') {
      return NextResponse.json({
        message: sub.status === 'active'
          ? 'Active subscriptions cannot be cancelled here. Contact support.'
          : 'This request is no longer pending.',
      }, { status: 409 });
    }

    // Issue full refund
    const refundRes = await paystackPost('/refund', {
      transaction:   sub.paystack_reference,
      merchant_note: 'Rider cancelled their ride request',
    });

    if (!refundRes.status) {
      console.error('[cancel-request] Refund failed:', refundRes);
      return NextResponse.json({ message: 'Refund failed — please contact support' }, { status: 500 });
    }

    // Update subscription
    await subRef.update({
      status:           'cancelled',
      refund_reference: refundRes.data?.reference ?? null,
      cancelled_at:     new Date().toISOString(),
      refunded_at:      new Date().toISOString(),
    });

    // Notify rider
    const riderDoc = await db.collection('users').doc(uid).get();
    const rider    = riderDoc.data();

    await Promise.all([
      notifyRefundIssued(uid,rider?.expo_push_token, sub.total_amount),
      sendRefundEmail({
        to:        sub.rider_billing_email,
        riderName: rider?.name ?? '',
        amount:    sub.total_amount,
        reference: sub.paystack_reference,
        reason:    'You cancelled your ride request',
      }),
    ]);

    return NextResponse.json({ result: 'cancelled_and_refunded' });

  } catch (err: any) {
    console.error('[cancel-request]', err);
    const status = err.message?.includes('Unauthorized') ? 401 : 500;
    return NextResponse.json({ message: err.message }, { status });
  }
}