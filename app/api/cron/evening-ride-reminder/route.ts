import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { enqueue } from '@/lib/queue';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

function lagosDateKey(): string {
  const lagosTime = new Date(Date.now() + 60 * 60 * 1000); // UTC+1
  return lagosTime.toISOString().split('T')[0];
}

export async function GET(req: NextRequest) {
  const startMs    = Date.now();
  const authHeader = req.headers.get('authorization');

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  try {
    const todayKey = lagosDateKey();

    const ridesSnap = await db.collection('daily_rides')
    .where('ride_date',      '==', todayKey)
    .where('evening_status', '==', 'pending')
    .get();

    if (ridesSnap.empty) {
      logger.info('cron_evening_reminders', { todayKey, processed: 0, durationMs: Date.now() - startMs });
      return NextResponse.json({ processed: 0 });
    }

    await Promise.all(
      ridesSnap.docs.map(doc =>
        enqueue('send_ride_reminder', {rideId: doc.id,})
      )
    );

    logger.info('cron_evening_reminders', {
      todayKey,
      processed:  ridesSnap.size,
      durationMs: Date.now() - startMs,
    });

    return NextResponse.json({ processed: ridesSnap.size });

  } catch (err: any) {
    logger.error('cron_evening_reminders_failed', err, {});
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}