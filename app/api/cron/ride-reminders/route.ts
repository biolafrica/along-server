import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging } from '@/lib/logger';

export const dynamic = 'force-dynamic';

function lagosDateKey(): string {
  // Lagos is UTC+1 — derive today's date in local time
  const lagosTime = new Date(Date.now() + 60 * 60 * 1000);
  return lagosTime.toISOString().split('T')[0];
}

async function handler(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const todayKey = lagosDateKey();

  const ridesSnap = await db.collection('daily_rides')
    .where('ride_date', '==', todayKey)
    .where('status',    '==', 'pending')
    .get();

  if (ridesSnap.empty) {
    logger.info('cron_ride_reminders', { todayKey, processed: 0 });
    return NextResponse.json({ processed: 0 });
  }

  // Fan out one job per ride,fetches user data, resolves departure time, sends push + Firestore notification for both host and rider.
  await Promise.all(
    ridesSnap.docs.map(doc =>
      enqueue('send_ride_reminder', { rideId: doc.id })
    )
  );

  logger.info('cron_ride_reminders', {
    todayKey,
    processed: ridesSnap.size,
  });

  return NextResponse.json({ processed: ridesSnap.size });
}

export const GET = withApiLogging('cron-ride-reminders', handler as any);

