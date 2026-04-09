import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

const MAX_NO_SHOWS = 3;

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { subscriptionId, dailyRideId } = await req.json();

  if (!subscriptionId || !dailyRideId) {
    return NextResponse.json({ message: 'Missing required fields' }, { status: 400 });
  }

  const subSnap = await dbOperation('firestore_read', 'subscriptions', subscriptionId, () =>
    db.collection('subscriptions').doc(subscriptionId).get()
  );

  if (!subSnap.exists) {
    return NextResponse.json({ message: 'Subscription not found' }, { status: 404 });
  }

  const sub = subSnap.data()!;

  if (sub.host_id !== uid) {
    return NextResponse.json({ message: 'Only the host can report a no-show' }, { status: 403 });
  }

  const currentCount = sub.no_show_count ?? 0;
  const newCount     = currentCount + 1;

  // CRITICAL PATH — update both docs in parallel
  await Promise.all([
    dbOperation('firestore_write', 'subscriptions', subscriptionId, () =>
      db.collection('subscriptions').doc(subscriptionId).update({
        no_show_count: newCount,
      })
    ),
    dbOperation('firestore_write', 'daily_rides', dailyRideId, () =>
      db.collection('daily_rides').doc(dailyRideId).update({
        status: 'no_show',
      })
    ),
  ]);

  const [riderDoc, hostDoc] = await Promise.all([
    dbOperation('firestore_read', 'users', sub.rider_id, () =>
      db.collection('users').doc(sub.rider_id).get()
    ),
    dbOperation('firestore_read', 'users', uid, () =>
      db.collection('users').doc(uid).get()
    ),
  ]);

  const rider    = riderDoc.data();
  const host     = hostDoc.data();

  // NON-CRITICAL — enqueue notification + email to rider
  await Promise.all([
    enqueue('send_notification', {
      type:        'no_show',
      userId:      sub.rider_id,
      token:       rider?.expo_push_token ?? null,
      hostName:    host?.name ?? 'Your host',
      noShowCount: newCount,
      maxNoShows:  MAX_NO_SHOWS,
    }),
    rider?.email && enqueue('send_email', {
      type:        'no_show',
      to:          rider.email,
      riderName:   rider.name ?? '',
      hostName:    host?.name ?? '',
      noShowCount: newCount,
      maxNoShows:  MAX_NO_SHOWS,
    }),
  ]);

  logger.info('no_show_reported', {
    subscriptionId,
    dailyRideId,
    riderId:     sub.rider_id,
    hostId:      uid,
    noShowCount: newCount,
  });

  return NextResponse.json({ reported: true, noShowCount: newCount });
}

export const POST = withApiLogging('report-no-show', handler as any);