import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging } from '@/lib/logger';

export const dynamic = 'force-dynamic';

async function handler(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date().toISOString();

  const expiredSnap = await db.collection('subscriptions')
    .where('status',   '==', 'active')
    .where('end_date', '<=', now)
    .get();

  if (expiredSnap.empty) {
    logger.info('cron_complete_expired_subscriptions', { processed: 0 });
    return NextResponse.json({ processed: 0 });
  }

  // Fan out, one independent job per subscription, If one fails it retries on its own without affecting others
  await Promise.all(
    expiredSnap.docs.map(doc =>
      enqueue('expire_subscription', { subscriptionId: doc.id })
    )
  );

  logger.info('cron_complete_expired_subscriptions', {
    processed: expiredSnap.size,
    subscriptionIds: expiredSnap.docs.map(d => d.id),
  });

  return NextResponse.json({ processed: expiredSnap.size });
}

export const GET = withApiLogging('cron-complete-expired-subscriptions', handler as any);