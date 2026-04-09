import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { withApiLogging } from '@/lib/logger';


async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { subscriptionId, rating, comment } = await req.json();

  if (!subscriptionId || !rating) {
    return NextResponse.json({ message: 'Missing subscriptionId or rating' }, { status: 400 });
  }
  if (rating < 1 || rating > 5) {
    return NextResponse.json({ message: 'Rating must be between 1 and 5' }, { status: 400 });
  }

  // Fetch subscription to validate and identify the rated party
  const subSnap = await db.collection('subscriptions').doc(subscriptionId).get();
  if (!subSnap.exists) {
    return NextResponse.json({ message: 'Subscription not found' }, { status: 404 });
  }

  const sub = subSnap.data()!;

  // Only completed subscriptions can be rated
  if (sub.status !== 'completed') {
    return NextResponse.json({ message: 'Can only rate completed subscriptions' }, { status: 409 });
  }

  // Verify caller is part of this subscription
  const isHost  = sub.host_id  === uid;
  const isRider = sub.rider_id === uid;
  if (!isHost && !isRider) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 403 });
  }

  // The rater rates the other party
  const ratedId = isHost ? sub.rider_id : sub.host_id;

  // Check if this caller already rated this subscription — one rating per party per sub
  const existing = await db.collection('ratings')
    .where('subscription_id', '==', subscriptionId)
    .where('rater_id',        '==', uid)
    .limit(1)
    .get();

  if (!existing.empty) {
    return NextResponse.json({ message: 'You have already rated this subscription' }, { status: 409 });
  }

  // Save rating
  await db.collection('ratings').add({
    subscription_id: subscriptionId,
    rater_id:        uid,
    rated_id:        ratedId,
    rating:          rating,
    comment:         comment?.trim() ?? null,
    rater_role:      isHost ? 'host' : 'rider',
    created_at:      FieldValue.serverTimestamp(),
  });

  // Mark on the subscription which parties have rated
  // so the UI can show/hide the CTA without querying ratings
  const ratedField = isHost ? 'host_has_rated' : 'rider_has_rated';
  await db.collection('subscriptions').doc(subscriptionId).update({
    [ratedField]: true,
  });

  return NextResponse.json({ success: true });

}

export const POST = withApiLogging('submit-rating', handler as any);
