import { NextRequest, NextResponse } from 'next/server';
import { paystackPost } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { logger, withApiLogging } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { hostId, riderEmail, amountKobo, durationMonths, pickupStop, metadata } = await req.json();

  if (!riderEmail || !amountKobo || !hostId) {
    return NextResponse.json({ message: 'Missing required fields' }, { status: 400 });
  }

  // Duplicate check
  const duplicateSnap = await db.collection('subscriptions')
    .where('rider_id', '==', uid)
    .where('status', 'in', ['pending', 'active'])
    .limit(1)
    .get();

  if (!duplicateSnap.empty) {
    const existing = duplicateSnap.docs[0].data();
    const message  = existing.status === 'pending'
      ? 'You already have a pending request. Wait for them to respond before requesting again.'
      : 'You already have an active subscription.';
    logger.warn('init_payment_duplicate', { uid, hostId, status: existing.status });
    return NextResponse.json({ message, code: 'DUPLICATE_SUBSCRIPTION' }, { status: 409 });
  }

  const reference = `usealong_${uid}_${Date.now()}`;

  const data = await paystackPost('/transaction/initialize', {
    email:        riderEmail,
    amount:       amountKobo,
    currency:     'NGN',
    reference,
    callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/payment-callback`,
    metadata: {
      ...metadata,
      host_id:         hostId,
      rider_id:        uid,
      duration_months: durationMonths,
      pickup_stop:     pickupStop,
    },
  });

  logger.info('payment_initialised', { uid, hostId, durationMonths, reference });

  return NextResponse.json({
    authUrl:   data.data.authorization_url,
    reference: data.data.reference,
  });
}

export const POST = withApiLogging('init-payment', handler as any);