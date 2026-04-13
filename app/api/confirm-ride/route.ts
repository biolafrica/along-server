import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { dailyRideId, leg } = await req.json();

  if (!dailyRideId) {
    return NextResponse.json({ message: 'Missing dailyRideId' }, { status: 400 });
  }

  const activeLeg: 'morning' | 'evening' = leg === 'evening' ? 'evening' : 'morning';

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

  // ── Determine which fields to update based on leg + role ─────────────────
  const riderField     = `${activeLeg}_rider_confirmed`;
  const riderAtField   = `${activeLeg}_rider_confirmed_at`;
  const hostField      = `${activeLeg}_host_confirmed`;
  const hostAtField    = `${activeLeg}_host_confirmed_at`;
  const legStatusField = `${activeLeg}_status`;

  const myField        = isHost ? hostField    : riderField;
  const myAtField      = isHost ? hostAtField  : riderAtField;
  const otherField     = isHost ? riderField   : hostField;

  // Already confirmed this leg — idempotent
  if (ride[myField]) {
    return NextResponse.json({ confirmed: true, completed: false, alreadyConfirmed: true });
  }

  const otherAlreadyConfirmed = ride[otherField] ?? false;

  const update: Record<string, any> = {
    [myField]:   true,
    [myAtField]: FieldValue.serverTimestamp(),
  };

  // Both confirmed this leg → leg complete
  if (otherAlreadyConfirmed) { update[legStatusField] = 'completed'}

  // Determine overall day status after this update
  const morningDone = activeLeg === 'morning' ? otherAlreadyConfirmed : ride.morning_status === 'completed';
  const eveningDone = activeLeg === 'evening' ? otherAlreadyConfirmed: ride.evening_status === 'completed';

  if (morningDone && eveningDone) {
    update.status       = 'completed';
    update.completed_at = FieldValue.serverTimestamp();
  } else if (morningDone) {
    update.status = 'morning_complete';
  }

  // CRITICAL PATH — write first
  await dbOperation('firestore_write', 'daily_rides', dailyRideId, () => dailyRef.update(update));

  const [riderDoc, hostDoc] = await Promise.all([
    dbOperation('firestore_read', 'users', ride.rider_id, () => db.collection('users').doc(ride.rider_id).get()),
    dbOperation('firestore_read', 'users', ride.host_id, () => db.collection('users').doc(ride.host_id).get()),
  ]);

  const rider = riderDoc.data();
  const host  = hostDoc.data();

  const legLabel = activeLeg === 'morning' ? 'morning' : 'evening';

  // NON-CRITICAL — enqueue notifications
  if (isRider && !ride[riderField]) {
    await enqueue('send_notification', {
      type:       'rider_confirmed_pickup',
      userId:     ride.host_id,
      token:      host?.expo_push_token ?? null,
      riderName:  rider?.name ?? 'Your rider',
      pickupStop: ride.pickup_stop ?? '',
      //leg:        legLabel,
    });
    logger.info('rider_confirmed_pickup', { dailyRideId, riderId: uid, leg: activeLeg });
  }

  if (isHost && !ride[hostField]) {
    await enqueue('send_notification', {
      type:     'host_confirmed_pickup',
      userId:   ride.rider_id,
      token:    rider?.expo_push_token ?? null,
      hostName: host?.name ?? 'Your host',
      //leg:      legLabel,
    });
    logger.info('host_confirmed_pickup', { dailyRideId, hostId: uid, leg: activeLeg });
  }

  return NextResponse.json({
    confirmed:  true,
    completed:  otherAlreadyConfirmed,
    leg:        activeLeg,
  });
}

export const POST = withApiLogging('confirm-ride', handler as any);