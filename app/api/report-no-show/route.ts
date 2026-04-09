import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { subscriptionId, dailyRideId } = await req.json();

    if (!subscriptionId || !dailyRideId) {
      return NextResponse.json({ message: 'Missing required fields' }, { status: 400 });
    }

    // Verify caller is the host
    const subSnap = await db.collection('subscriptions').doc(subscriptionId).get();
    if (!subSnap.exists) {
      return NextResponse.json({ message: 'Subscription not found' }, { status: 404 });
    }
    const sub = subSnap.data()!;
    if (sub.host_id !== uid) {
      return NextResponse.json({ message: 'Only the host can report a no-show' }, { status: 403 });
    }

    const currentCount = sub.no_show_count ?? 0;

    // Update both docs in parallel
    await Promise.all([
      db.collection('subscriptions').doc(subscriptionId).update({
        no_show_count: currentCount + 1,
      }),
      db.collection('daily_rides').doc(dailyRideId).update({
        status: 'no_show',
      }),
    ]);

    // Notify rider
    const [riderDoc, hostDoc] = await Promise.all([
      db.collection('users').doc(sub.rider_id).get(),
      db.collection('users').doc(uid).get(),
    ]);
    const rider    = riderDoc.data();
    const host     = hostDoc.data();
    const newCount = currentCount + 1;

    const body = newCount >= 3
      ? `You've been marked as a no-show by ${host?.name ?? 'your host'}. After 3 no-shows you may be removed from the route.`
      : `You were marked as a no-show by ${host?.name ?? 'your host'} today (${newCount}/3). Please communicate in advance if you can't make it.`;

    // In-app notification
    await db.collection('notifications').add({
      user_id:    sub.rider_id,
      type:       'no_show',
      title:      'Marked as no-show',
      body,
      url:        '/(tabs)/rides',
      read:       false,
      created_at: FieldValue.serverTimestamp(),
    });

    // Push
    if (rider?.expo_push_token?.startsWith('ExponentPushToken')) {
      await fetch(EXPO_PUSH_URL, {
        method:  'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body:    JSON.stringify([{
          to:    rider.expo_push_token,
          title: 'Marked as no-show',
          body,
          data:  { type: 'no_show', url: '/(tabs)/rides' },
          sound: 'default',
        }]),
      }).catch(err => console.error('[report-no-show] push failed:', err.message));
    }

    return NextResponse.json({ reported: true, noShowCount: newCount });

  } catch (err: any) {
    console.error('[report-no-show]', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}