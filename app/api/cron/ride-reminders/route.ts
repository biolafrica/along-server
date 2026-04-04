import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { notifyRideReminder } from '@/lib/notification';
import { formatTime } from '@/utils/formatter';

export const dynamic = 'force-dynamic';

// Runs at 6 AM Lagos time (5 AM UTC) every day.

function lagosDateKey(): string {
  const now        = new Date();
  const lagosTime  = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1
  return lagosTime.toISOString().split('T')[0];
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const todayKey = lagosDateKey();
  console.log('[cron/ride-reminders] Running for date:', todayKey);

  // Fetch all pending daily_rides for today
  const ridesSnap = await db.collection('daily_rides')
    .where('ride_date', '==', todayKey)
    .where('status',    '==', 'pending')
    .get();

  if (ridesSnap.empty) {
    console.log('[cron/ride-reminders] No rides today');
    return NextResponse.json({ notified: 0 });
  }

  let notified = 0;

  for (const rideDoc of ridesSnap.docs) {
    const ride = rideDoc.data();

    try {
      // Fetch host and rider in parallel
      const [hostDoc, riderDoc, hostProfileDoc] = await Promise.all([
        db.collection('users').doc(ride.host_id).get(),
        db.collection('users').doc(ride.rider_id).get(),
        db.collection('hosts').doc(ride.host_id).get(),
      ]);

      const host        = hostDoc.data();
      const rider       = riderDoc.data();
      const hostProfile = hostProfileDoc.data();

      // Get departure time from host schedule
      const DAY_NAMES   = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const dayName     = DAY_NAMES[new Date().getDay()];
      const departTime  = hostProfile?.schedule?.[dayName]?.depart ?? '';
      const displayTime = departTime
        ? formatTime(departTime)
        : '—';

      await Promise.all([
        // Remind host
        host?.expo_push_token && notifyRideReminder(
          ride.host_id,
          host.expo_push_token,
          'host',
          displayTime,
        ),
        // Remind rider
        rider?.expo_push_token && notifyRideReminder(
          ride.rider_id,
          rider.expo_push_token,
          'rider',
          displayTime,
          ride.pickup_stop,
        ),
      ]);

      notified += 2;
    } catch (err: any) {
      console.error('[cron/ride-reminders] Failed for ride', rideDoc.id, err.message);
    }
  }

  console.log(`[cron/ride-reminders] Sent reminders for ${ridesSnap.size} rides (${notified} notifications)`);
  return NextResponse.json({ rides: ridesSnap.size, notified });
}

