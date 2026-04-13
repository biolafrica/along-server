import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { dailyRideId } = await req.json();

  if (!dailyRideId) {
    return NextResponse.json({ message: 'Missing dailyRideId' }, { status: 400 });
  }

  const dailyRef  = db.collection('daily_rides').doc(dailyRideId);
  const dailySnap = await dbOperation('firestore_read', 'daily_rides', dailyRideId, () =>
    dailyRef.get()
  );

  if (!dailySnap.exists) {
    return NextResponse.json({ message: 'Daily ride not found' }, { status: 404 });
  }

  const ride    = dailySnap.data()!;
  const isHost  = ride.host_id  === uid;
  const isRider = ride.rider_id === uid;

  if (!isHost && !isRider) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 403 });
  }

  const otherAlreadyConfirmed = isHost ? ride.rider_confirmed : ride.host_confirmed;

  const update: Record<string, any> = {
    [isHost ? 'host_confirmed' : 'rider_confirmed']: true,
  };

  if (otherAlreadyConfirmed) {
    update.status       = 'completed';
    update.completed_at = FieldValue.serverTimestamp();
  }

  // CRITICAL PATH — write confirmation first
  await dbOperation('firestore_write', 'daily_rides', dailyRideId, () =>
    dailyRef.update(update)
  );

  const [riderDoc, hostDoc] = await Promise.all([
    dbOperation('firestore_read', 'users', ride.rider_id, () =>
      db.collection('users').doc(ride.rider_id).get()
    ),
    dbOperation('firestore_read', 'users', ride.host_id, () =>
      db.collection('users').doc(ride.host_id).get()
    ),
  ]);

  const rider = riderDoc.data();
  const host  = hostDoc.data();

  // NON-CRITICAL — enqueue notifications based on who confirmed
  if (isRider && !ride.rider_confirmed) {
    // Rider confirmed morning pickup — notify host
    await Promise.all([
      enqueue('send_notification', {
        type:       'rider_confirmed_pickup',
        userId:     ride.host_id,
        token:      host?.expo_push_token ?? null,
        riderName:  rider?.name ?? 'Your rider',
        pickupStop: ride.pickup_stop ?? '',
      }),
      host?.email && enqueue('send_email', {
        type:          'rider_trip_confirmed',
        to:            host.email,
        hostName:      host.name ?? '',
        riderName:     rider?.name ?? '',
        pickupStop:    ride.pickup_stop ?? '',
        departureTime: ride.departure_time ?? '—',
      }),
    ]);
    logger.info('rider_confirmed_pickup', { dailyRideId, riderId: uid });
  }

  if (isHost && !ride.host_confirmed) {
    // Host confirmed pickup — notify rider
    await Promise.all([
      enqueue('send_notification', {
        type:     'host_confirmed_pickup',
        userId:   ride.rider_id,
        token:    rider?.expo_push_token ?? null,
        hostName: host?.name ?? 'Your host',
      }),
      rider?.email && enqueue('send_email', {
        type:      'host_pickup_confirmed',
        to:        rider.email,
        riderName: rider.name ?? '',
        hostName:  host?.name ?? '',
      }),
    ]);
    logger.info('host_confirmed_pickup', { dailyRideId, hostId: uid });
  }

  // // Both confirmed — ride completed, notify both parties
  // if (otherAlreadyConfirmed) {
  //   await Promise.all([
  //     enqueue('send_notification', {
  //       type:      'ride_completed',
  //       userId:    ride.rider_id,
  //       token:     rider?.expo_push_token ?? null,
  //       role:      'rider',
  //       otherName: host?.name ?? 'Your host',
  //     }),
  //     enqueue('send_notification', {
  //       type:      'ride_completed',
  //       userId:    ride.host_id,
  //       token:     host?.expo_push_token ?? null,
  //       role:      'host',
  //       otherName: rider?.name ?? 'Your rider',
  //     }),
  //   ]);
  //   logger.info('ride_completed', { dailyRideId });
  // }

  return NextResponse.json({ confirmed: true, completed: !!otherAlreadyConfirmed });
}

export const POST = withApiLogging('confirm-ride', handler as any);

