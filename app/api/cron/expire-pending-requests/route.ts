import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const startMs    = Date.now();
  const authHeader = req.headers.get('authorization');

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now         = new Date().toISOString();
    const expiredSnap = await db.collection('subscriptions')
      .where('status',            '==', 'pending')
      .where('response_deadline', '<=', now)
      .get();

    if (expiredSnap.empty) {
      logger.info('cron_expire_pending_requests', { processed: 0, durationMs: Date.now() - startMs });
      return NextResponse.json({ processed: 0 });
    }

    await Promise.all(
      expiredSnap.docs.map(doc =>
        enqueue('cancel_pending_request', { subscriptionId: doc.id })
      )
    );

    logger.info('cron_expire_pending_requests', {
      processed:       expiredSnap.size,
      subscriptionIds: expiredSnap.docs.map(d => d.id),
      durationMs:      Date.now() - startMs,
    });

    return NextResponse.json({ processed: expiredSnap.size });

  } catch (err: any) {
    logger.error('cron_expire_pending_requests_failed', err, {});
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}