import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { paystackPost } from '@/lib/paystack';
import { FieldValue } from 'firebase-admin/firestore';
import { notifyRequestDeclined, notifyRefundIssued } from '@/lib/notification';
import { sendRequestDeclinedEmail, sendRefundEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date().toISOString();

  const expiredSnap = await db.collection('subscriptions')
    .where('status',            '==', 'pending')
    .where('response_deadline', '<=', now)
    .get();

  if (expiredSnap.empty) {
    console.log('[cron/expire-requests] No expired requests found');
    return NextResponse.json({ processed: 0 });
  }

  const results: string[] = [];

  for (const subDoc of expiredSnap.docs) {
    const sub   = subDoc.data();
    const subId = subDoc.id;

    try {
      const refundRes = await paystackPost('/refund', {
        transaction:   sub.paystack_reference,
        merchant_note: 'Auto-refunded: host did not respond within 48 hours',
      });

      if (!refundRes.status) {
        console.error(`[cron/expire-requests] Refund failed for ${subId}:`, refundRes.message);
        results.push(`${subId}: REFUND_FAILED — ${refundRes.message}`);
        continue;
      }

      await subDoc.ref.update({
        status:           'expired',
        refund_reference: refundRes.data?.reference ?? null,
        refund_reason:    'Host did not respond within 48 hours',
        refunded_at:      FieldValue.serverTimestamp(),
      });

      const [riderDoc, hostDoc] = await Promise.all([
        db.collection('users').doc(sub.rider_id).get(),
        db.collection('users').doc(sub.host_id).get(),
      ]);
      const rider = riderDoc.data();
      const host  = hostDoc.data();

      await Promise.all([
        notifyRequestDeclined(
          sub.rider_id,
          rider?.expo_push_token ?? null,
          host?.name ?? 'Your host',
          'expired',
        ),
        notifyRefundIssued(
          sub.rider_id,
          rider?.expo_push_token ?? null,
          sub.total_amount,
        ),
        rider?.email && sendRequestDeclinedEmail({
          to:        rider.email,
          riderName: rider.name ?? '',
          hostName:  host?.name ?? '',
          reason:    'expired',
        }),
        rider?.email && sendRefundEmail({
          to:        rider.email,
          riderName: rider.name ?? '',
          amount:    sub.total_amount,
          reference: sub.paystack_reference,
          reason:    'Host did not respond within 48 hours',
        }),
      ]);

      results.push(`${subId}: OK — refunded ₦${sub.total_amount}`);
      console.log(`[cron/expire-requests] Expired and refunded ${subId}`);

    } catch (err: any) {
      results.push(`${subId}: ERROR — ${err.message}`);
      console.error(`[cron/expire-requests] Failed for ${subId}:`, err.message);
    }
  }

  return NextResponse.json({ processed: expiredSnap.size, results });
}