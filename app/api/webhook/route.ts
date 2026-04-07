import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

export const dynamic = 'force-dynamic';

async function handler(req: NextRequest): Promise<NextResponse> {
  const rawBody   = await req.text();
  const signature = req.headers.get('x-paystack-signature') ?? '';

  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!)
    .update(rawBody)
    .digest('hex');

  if (hash !== signature) {
    logger.warn('webhook_invalid_signature', { layer: 'request' });
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const event     = JSON.parse(rawBody);
  const eventType = event.event as string;

  logger.info('webhook_received', { eventType, reference: event.data?.reference ?? '' });

  switch (eventType) {

    case 'charge.success': {
      const { reference, metadata } = event.data;
      if (!metadata?.renewal || !metadata?.subscription_id) break;

      const subRef  = db.collection('subscriptions').doc(metadata.subscription_id);
      const subSnap = await dbOperation('firestore_read', 'subscriptions', metadata.subscription_id, () =>
        subRef.get()
      );

      if (!subSnap.exists) {
        logger.warn('webhook_subscription_not_found', { eventType, subscriptionId: metadata.subscription_id });
        break;
      }

      const sub    = subSnap.data()!;
      const newEnd = new Date(sub.end_date);
      newEnd.setMonth(newEnd.getMonth() + (sub.duration_months ?? 1));

      await dbOperation('firestore_write', 'subscriptions', metadata.subscription_id, () =>
        subRef.update({
          end_date:              newEnd.toISOString(),
          last_charged_at:       new Date().toISOString(),
          last_charge_reference: reference,
          status:                'active',
        })
      );

      const [riderDoc, hostDoc] = await Promise.all([
        dbOperation('firestore_read', 'users', sub.rider_id, () =>
          db.collection('users').doc(sub.rider_id).get()
        ),
        dbOperation('firestore_read', 'users', sub.host_id, () =>
          db.collection('users').doc(sub.host_id).get()
        ),
      ]);

      await enqueue('send_notification', {
        type:     'renewal_charged',
        userId:   sub.rider_id,
        token:    riderDoc.data()?.expo_push_token ?? null,
        amount:   sub.total_amount,
        hostName: hostDoc.data()?.name ?? '',
      });

      logger.info('renewal_extended', {
        subscriptionId: metadata.subscription_id,
        newEndDate:     newEnd.toISOString(),
        reference,
      });
      break;
    }

    case 'charge.failed': {
      const { metadata } = event.data;
      if (!metadata?.renewal || !metadata?.subscription_id) break;

      const subRef  = db.collection('subscriptions').doc(metadata.subscription_id);
      const subSnap = await dbOperation('firestore_read', 'subscriptions', metadata.subscription_id, () =>
        subRef.get()
      );
      if (!subSnap.exists) break;

      const sub = subSnap.data()!;

      await dbOperation('firestore_write', 'subscriptions', metadata.subscription_id, () =>
        subRef.update({ status: 'payment_failed' })
      );

      const [riderDoc, hostDoc] = await Promise.all([
        dbOperation('firestore_read', 'users', sub.rider_id, () =>
          db.collection('users').doc(sub.rider_id).get()
        ),
        dbOperation('firestore_read', 'users', sub.host_id, () =>
          db.collection('users').doc(sub.host_id).get()
        ),
      ]);

      await enqueue('send_notification', {
        type:     'renewal_failed',
        userId:   sub.rider_id,
        token:    riderDoc.data()?.expo_push_token ?? null,
        hostName: hostDoc.data()?.name ?? '',
      });

      logger.warn('renewal_payment_failed', {
        subscriptionId: metadata.subscription_id,
      }, 'warning');
      break;
    }

    case 'transfer.success': {
      const { reference, amount, recipient } = event.data;

      const subSnap = await db.collection('subscriptions')
        .where('transfer_reference', '==', reference)
        .limit(1)
        .get();

      if (subSnap.empty) {
        logger.warn('webhook_transfer_sub_not_found', { reference });
        break;
      }

      const subDoc = subSnap.docs[0];
      const sub    = subDoc.data();

      await dbOperation('firestore_write', 'subscriptions', subDoc.id, () =>
        subDoc.ref.update({
          transfer_status:       'success',
          transfer_confirmed_at: FieldValue.serverTimestamp(),
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

      const host        = hostDoc.data();
      const riderName   = riderDoc.data()?.name ?? 'your rider';
      const amountNaira = Math.round(amount / 100);
      const period      = new Date(sub.end_date).toLocaleString('en-NG', {
        month: 'long', year: 'numeric',
      });

      await Promise.all([
        enqueue('send_notification', {
          type:      'earnings_credited',
          userId:    sub.host_id,
          token:     host?.expo_push_token ?? null,
          amount:    amountNaira,
          riderName,
        }),
        host?.email && enqueue('send_email', {
          type:      'earnings_credited',
          to:        host.email,
          hostName:  host.name ?? '',
          amount:    amountNaira,
          riderName,
          period,
        }),
      ]);

      logger.info('transfer_confirmed', {
        subscriptionId: subDoc.id,
        reference,
        amountNaira,
        hostId:         sub.host_id,
        accountName:    recipient?.details?.account_name ?? '',
      });
      break;
    }

    case 'transfer.failed': {
      const { reference, failure_reason } = event.data;

      const subSnap = await db.collection('subscriptions')
        .where('transfer_reference', '==', reference)
        .limit(1)
        .get();

      if (subSnap.empty) {
        logger.warn('webhook_transfer_failed_sub_not_found', { reference });
        break;
      }

      const subDoc = subSnap.docs[0];
      const sub    = subDoc.data();

      await dbOperation('firestore_write', 'subscriptions', subDoc.id, () =>
        subDoc.ref.update({
          transfer_status:         'failed',
          transfer_failure_reason: failure_reason ?? 'Unknown',
          transfer_failed_at:      FieldValue.serverTimestamp(),
        })
      );

      // Money problem — fire a fatal Sentry alert
      logger.critical(
        'transfer_failed',
        new Error(failure_reason ?? 'Paystack transfer failed'),
        {
          subscriptionId: subDoc.id,
          reference,
          reason:         failure_reason,
          hostId:         sub.host_id,
          amount:         `₦${Math.round((event.data.amount ?? 0) / 100)}`,
        }
      );
      break;
    }

    case 'refund.processed': {
      logger.info('refund_confirmed', { reference: event.data?.reference });
      break;
    }

    default:
      logger.info('webhook_unhandled_event', { eventType });
  }

  return NextResponse.json({ received: true });
}

// Wrap with request logging — logs method, path, statusCode, durationMs
export const POST = withApiLogging('webhook', handler as any);