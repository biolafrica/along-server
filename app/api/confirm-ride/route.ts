import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { notifyRideCompleted } from '@/lib/notification';
import { sendRideCompletedEmail } from '@/lib/email';

// Shared endpoint for both host and rider to confirm a daily ride.
// Determines who is calling, sets the right field, and fires the
// appropriate notification to the other party.

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { dailyRideId } = await req.json();

    if (!dailyRideId) {
      return NextResponse.json({ message: 'Missing dailyRideId' }, { status: 400 });
    }

    const dailyRef  = db.collection('daily_rides').doc(dailyRideId);
    const dailySnap = await dailyRef.get();

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

    await dailyRef.update(update);

    // ── Fetch both parties for notifications ──────────────────────────────────
    const [riderDoc, hostDoc] = await Promise.all([
      db.collection('users').doc(ride.rider_id).get(),
      db.collection('users').doc(ride.host_id).get(),
    ]);
    const rider = riderDoc.data();
    const host  = hostDoc.data();

    if (isRider && !ride.rider_confirmed) {
      // Rider just confirmed — notify host that rider is ready
      await notifyRiderConfirmed(
        ride.host_id,
        host?.expo_push_token ?? null,
        rider?.name ?? 'Your rider',
        ride.pickup_stop ?? '',
      );
    }

    if (isHost && !ride.host_confirmed) {
      // Host just confirmed — notify rider that host is on the way
      await notifyHostConfirmed(
        ride.rider_id,
        rider?.expo_push_token ?? null,
        host?.name ?? 'Your host',
      );
    }

    // Both confirmed — ride completed
    if (otherAlreadyConfirmed) {
      const date = new Date().toISOString();
      await Promise.all([
        notifyRideCompleted(ride.rider_id, rider?.expo_push_token ?? null, 'rider', host?.name  ?? ''),
        notifyRideCompleted(ride.host_id,  host?.expo_push_token  ?? null, 'host',  rider?.name ?? ''),
        rider?.email && sendRideCompletedEmail({ to: rider.email, name: rider.name ?? '', role: 'rider', otherName: host?.name  ?? '', date }),
        host?.email  && sendRideCompletedEmail({ to: host.email,  name: host.name  ?? '', role: 'host',  otherName: rider?.name ?? '', date }),
      ]);
    }

    return NextResponse.json({ confirmed: true, completed: !!otherAlreadyConfirmed });

  } catch (err: any) {
    console.error('[confirm-ride]', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}

// ─── Inline notification helpers ─────────────────────────────────────────────
// These are lightweight — same Expo push pattern as the main notifications lib
// but specific to the pickup confirmation flow.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPush(to: string, title: string, body: string, data: Record<string, string>) {
  if (!to?.startsWith('ExponentPushToken')) return;
  await fetch(EXPO_PUSH_URL, {
    method:  'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body:    JSON.stringify([{ to, title, body, data, sound: 'default' }]),
  }).catch(err => console.error('[confirm-ride] push failed:', err.message));
}

async function notifyRiderConfirmed(
  userId:    string,
  token:     string | null,
  riderName: string,
  pickupStop:string,
) {
  // Write in-app notification
  await db.collection('notifications').add({
    user_id:    userId,
    type:       'rider_confirmed',
    title:      'Rider confirmed',
    body:       `${riderName} confirmed they'll be at ${pickupStop || 'their stop'} as agreed.`,
    url:        '/(tabs)/rides',
    read:       false,
    created_at: FieldValue.serverTimestamp(),
  });
  // Push
  if (token) {
    await sendPush(
      token,
      'Rider confirmed',
      `${riderName} confirmed they'll be at ${pickupStop || 'their stop'} as agreed.`,
      { type: 'rider_confirmed', url: '/(tabs)/rides' },
    );
  }
}

async function notifyHostConfirmed(
  userId:   string,
  token:    string | null,
  hostName: string,
) {
  await db.collection('notifications').add({
    user_id:    userId,
    type:       'host_confirmed Pickup',
    title:      'Your host has confirmed your pickup',
    body:       `${hostName} confirmed your pickup. Enjoy your ride!`,
    url:        '/(tabs)/rides',
    read:       false,
    created_at: FieldValue.serverTimestamp(),
  });
  if (token) {
    await sendPush(
      token,
      'Your host has confirmed your pickup',
      `${hostName} confirmed your pickup. Enjoy your ride!`,
      { type: 'host_confirmed', url: '/(tabs)/rides' },
    );
  }
}