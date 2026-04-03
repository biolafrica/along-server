import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { paystackPost } from '@/lib/paystack';
import { notifyRenewalCharged} from '@/lib/notification';


export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-internal-secret');
  if (secret !== process.env.INTERNAL_SECRET) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  try {
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

    if (sub.status !== 'active') {
      return NextResponse.json({ message: `Subscription is ${sub.status}, not active` }, { status: 409 });
    }

    await subRef.update({
      status:       'completed',
      completed_at: FieldValue.serverTimestamp(),
    });

    const hostDoc  = await db.collection('users').doc(sub.host_id).get();
    const hostData = hostDoc.data();

    if (!hostData?.paystack_recipient_code) {
      console.warn(`[complete-subscription] Host ${sub.host_id} has no recipient_code — skipping transfer`);
      return NextResponse.json({ result: 'completed_no_transfer', reason: 'no_recipient_code' });
    }

    const period    = new Date(sub.end_date).toLocaleString('en-NG', { month: 'long', year: 'numeric' });
    const reference = `along_payout_${subscriptionId}_${Date.now()}`;

    const transferRes = await paystackPost('/transfer', {
      source:         'balance',
      amount:         sub.host_earning * 100, // kobo
      recipient:      hostData.paystack_recipient_code,
      reason:         `Along earnings — ${period}`,
      reference,
      currency:       'NGN',
    });

    if (!transferRes.status) {
      console.error('[complete-subscription] Transfer failed:', transferRes.message);
      await subRef.update({ transfer_status: 'failed', transfer_error: transferRes.message });
      return NextResponse.json({ result: 'completed_transfer_failed', error: transferRes.message });
    }

    await subRef.update({
      transfer_code:      transferRes.data?.transfer_code ?? null,
      transfer_reference: reference,
      transfer_status:    transferRes.data?.status ?? 'pending',
      transfer_initiated_at: FieldValue.serverTimestamp(),
    });

    await notifyRenewalCharged(
      sub.host_id,
      hostData.expo_push_token,
      sub.host_earning,
      'your subscription earnings',
    );

    console.log(`[complete-subscription] Completed ${subscriptionId}, transfer ${reference}`);
    return NextResponse.json({ result: 'completed_and_transferred', reference });

  } catch (err: any) {
    console.error('[complete-subscription]', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}