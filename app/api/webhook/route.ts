import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/firebase-admin';
import { notifyRenewalCharged, notifyRenewalFailed } from '@/lib/notification';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const rawBody  = await req.text();
  const signature = req.headers.get('x-paystack-signature') ?? '';

  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
    .update(rawBody)
    .digest('hex');

  if (hash !== signature) {
    console.warn('[webhook] Invalid signature');
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const event    = JSON.parse(rawBody);
  const eventType: string = event.event;
  console.log('[webhook] Event:', eventType);

  switch (eventType) {

    case 'charge.success': {
      const { reference, metadata } = event.data;

      // Only handle renewal charges — initial payments are handled in /verify-payment
      if (metadata?.renewal && metadata?.subscription_id) {
        const subRef  = db.collection('subscriptions').doc(metadata.subscription_id);
        const subSnap = await subRef.get();
        if (!subSnap.exists) break;

        const sub     = subSnap.data()!;
        const newEnd  = new Date(sub.end_date);
        newEnd.setMonth(newEnd.getMonth() + (sub.duration_months ?? 1));

        console.log(`[webhook] Renewal charge successful for subscription ${metadata.subscription_id}. Extending end date to ${newEnd.toISOString()}`);

        await subRef.update({
          end_date:              newEnd.toISOString(),
          last_charged_at:       new Date().toISOString(),
          last_charge_reference: reference,
          status:                'active', // restore if it was payment_failed
        });

        // Notify rider
        const riderDoc = await db.collection('users').doc(sub.rider_id).get();
        const hostDoc  = await db.collection('users').doc(sub.host_id).get();

        console.log(`[webhook] Notifying rider ${sub.rider_id} about successful renewal charge of ${sub.total_amount} for host ${hostDoc.data()?.name}`);

        await notifyRenewalCharged(
          riderDoc.data()?.id ?? '',
          riderDoc.data()?.expo_push_token,
          sub.total_amount,
          hostDoc.data()?.name ?? '',
        );
      }
      break;
    }

    case 'charge.failed': {
      const { metadata } = event.data;
      if (metadata?.renewal && metadata?.subscription_id) {
        const subRef = db.collection('subscriptions').doc(metadata.subscription_id);
        await subRef.update({ status: 'payment_failed' });

        const subSnap  = await subRef.get();
        const sub      = subSnap.data()!;
        const riderDoc = await db.collection('users').doc(sub.rider_id).get();
        const hostDoc  = await db.collection('users').doc(sub.host_id).get();

        console.log(`[webhook] Notifying rider ${sub.rider_id} about failed renewal charge for host ${hostDoc.data()?.name}`);
        
        await notifyRenewalFailed(
          riderDoc.data()?.id ?? '',
          riderDoc.data()?.expo_push_token,
          hostDoc.data()?.name ?? '',
        );
      }
      break;
    }

    case 'refund.processed': {
      const { reference } = event.data;
      console.log('[webhook] Refund processed for ref:', reference);
      // Subscription status already updated in handle-host-decision or auto-expiry
      break;
    }

    case 'transfer.success':
    case 'transfer.failed':
      // Future: host payouts
      console.log('[webhook] Transfer event:', eventType, event.data?.reference);
      break;

    default:
      console.log('[webhook] Unhandled event:', eventType);
  }

  return NextResponse.json({ received: true });
}