import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/firebase-admin';
import { notifyEarningsCredited, notifyRenewalCharged, notifyRenewalFailed } from '@/lib/notification';
import { FieldValue } from 'firebase-admin/firestore';
import { sendEarningsCreditedEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const rawBody   = await req.text();
  const signature = req.headers.get('x-paystack-signature') ?? '';

  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
    .update(rawBody)
    .digest('hex');

  if (hash !== signature) {
    console.warn('[webhook] Invalid signature');
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const event     = JSON.parse(rawBody);
  const eventType = event.event as string;
  console.log('[webhook] Event:', eventType, event.data?.reference ?? '');

  switch (eventType) {
    
    case 'charge.success': {
      const { reference, metadata } = event.data;

      if (!metadata?.renewal || !metadata?.subscription_id) break;

      const subRef  = db.collection('subscriptions').doc(metadata.subscription_id);
      const subSnap = await subRef.get();
      if (!subSnap.exists) {
        console.warn('[webhook] charge.success — subscription not found:', metadata.subscription_id);
        break;
      }

      const sub    = subSnap.data()!;
      const newEnd = new Date(sub.end_date);
      newEnd.setMonth(newEnd.getMonth() + (sub.duration_months ?? 1));

      await subRef.update({
        end_date:              newEnd.toISOString(),
        last_charged_at:       new Date().toISOString(),
        last_charge_reference: reference,
        status:                'active',
      });

      const [riderDoc, hostDoc] = await Promise.all([
        db.collection('users').doc(sub.rider_id).get(),
        db.collection('users').doc(sub.host_id).get(),
      ]);

      await notifyRenewalCharged(
        sub.rider_id,
        riderDoc.data()?.expo_push_token ?? null,
        sub.total_amount,
        hostDoc.data()?.name ?? '',
      );

      console.log('[webhook] Renewal extended to', newEnd.toISOString(), 'for', metadata.subscription_id);
      break;
    }

    case 'charge.failed': {
      const { metadata } = event.data;

      if (!metadata?.renewal || !metadata?.subscription_id) break;

      const subRef  = db.collection('subscriptions').doc(metadata.subscription_id);
      const subSnap = await subRef.get();
      if (!subSnap.exists) break;

      const sub = subSnap.data()!;

      await subRef.update({ status: 'payment_failed' });

      const [riderDoc, hostDoc] = await Promise.all([
        db.collection('users').doc(sub.rider_id).get(),
        db.collection('users').doc(sub.host_id).get(),
      ]);

      await notifyRenewalFailed(
        sub.rider_id,
        riderDoc.data()?.expo_push_token ?? null,
        hostDoc.data()?.name ?? '',
      );

      console.log('[webhook] Renewal failed for', metadata.subscription_id);
      break;
    }

    case 'transfer.success': {
      const { reference, amount, recipient } = event.data;

      const subSnap = await db.collection('subscriptions')
        .where('transfer_reference', '==', reference)
        .limit(1)
        .get();

      if (subSnap.empty) {
        console.warn('[webhook] transfer.success — no subscription found for ref:', reference);
        break;
      }

      const subDoc = subSnap.docs[0];
      const sub    = subDoc.data();

      await subDoc.ref.update({
        transfer_status:      'success',
        transfer_confirmed_at: FieldValue.serverTimestamp(),
      });

      const hostDoc = await db.collection('users').doc(sub.host_id).get();
      const host    = hostDoc.data();

      const amountNaira = Math.round(amount / 100); // kobo → naira
      const period      = new Date(sub.end_date).toLocaleString('en-NG', {
        month: 'long', year: 'numeric',
      });

      const riderDoc  = await db.collection('users').doc(sub.rider_id).get();
      const riderName = riderDoc.data()?.name ?? 'your rider';

      await Promise.all([
        notifyEarningsCredited(
          sub.host_id,
          host?.expo_push_token ?? null,
          amountNaira,
          riderName,
        ),
        host?.email && sendEarningsCreditedEmail({
          to:        host.email,
          hostName:  host.name ?? '',
          amount:    amountNaira,
          riderName,
          period,
        }),
      ]);

      console.log(`[webhook] Transfer confirmed: ₦${amountNaira} to ${recipient?.details?.account_name ?? 'host'} for sub ${subDoc.id}`);
      break;
    }

    case 'transfer.failed': {
      const { reference, failure_reason } = event.data;

      const subSnap = await db.collection('subscriptions')
        .where('transfer_reference', '==', reference)
        .limit(1)
        .get();

      if (subSnap.empty) {
        console.warn('[webhook] transfer.failed — no subscription found for ref:', reference);
        break;
      }

      const subDoc = subSnap.docs[0];
      const sub    = subDoc.data();

      await subDoc.ref.update({
        transfer_status:      'failed',
        transfer_failure_reason: failure_reason ?? 'Unknown',
        transfer_failed_at:   FieldValue.serverTimestamp(),
      });

      console.error(
        `[webhook] TRANSFER FAILED for subscription ${subDoc.id}`,
        `ref: ${reference}`,
        `reason: ${failure_reason}`,
        `host: ${sub.host_id}`,
        `amount: ₦${Math.round((event.data.amount ?? 0) / 100)}`,
      );

      // An admin alert system would go here in production.
      break;
    }

    // Subscription status already updated when we called /refund — nothing to do here.
    case 'refund.processed': {
      console.log('[webhook] Refund confirmed for ref:', event.data?.reference);
      break;
    }

    default:
      console.log('[webhook] Unhandled event:', eventType);
  }

  return NextResponse.json({ received: true });
}