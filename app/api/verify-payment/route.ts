import { NextRequest, NextResponse } from 'next/server';
import { paystackGet } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { reference } = await req.json();

  if (!reference) {
    return NextResponse.json({ message: 'Reference required' }, { status: 400 });
  }

  const data = await paystackGet(`/transaction/verify/${reference}`);

  if (data.data.status !== 'success') {
    logger.warn('verify_payment_not_successful', { reference, status: data.data.status });
    return NextResponse.json({ message: 'Payment was not successful' }, { status: 402 });
  }

  const txn  = data.data;
  const auth = txn.authorization;
  const meta = txn.metadata ?? {};

  const hostId         = meta.host_id         as string;
  const durationMonths = Number(meta.duration_months ?? 1);
  const pickupStop     = meta.pickup_stop      as string ?? '';
  const monthlyPrice   = Number(meta.monthly_price ?? 0);
  const riderEmail     = txn.customer.email    as string;

  if (!hostId) {
    return NextResponse.json({ message: 'Invalid payment metadata — host_id missing' }, { status: 400 });
  }

  // CRITICAL PATH — store authorization
  await dbOperation('firestore_write', 'users', uid, () =>
    db.collection('users').doc(uid).update({
      paystack_authorization_code: auth.authorization_code,
      paystack_email:              txn.customer.email,
      paystack_card_last4:         auth.last4,
      paystack_card_brand:         auth.brand,
      paystack_card_bank:          auth.bank,
    })
  );

  const [riderDoc, hostDoc] = await Promise.all([
    dbOperation('firestore_read', 'users', uid, () =>
      db.collection('users').doc(uid).get()
    ),
    dbOperation('firestore_read', 'users', hostId, () =>
      db.collection('users').doc(hostId).get()
    ),
  ]);

  const rider = riderDoc.data();
  const host  = hostDoc.data();

  const SERVICE_FEE_RATE = 0.10;
  const baseAmount       = monthlyPrice * durationMonths;
  const serviceFee       = Math.round(baseAmount * SERVICE_FEE_RATE);
  const totalAmount      = baseAmount + serviceFee;
  const hostEarning      = baseAmount;

  const startDate        = new Date();
  const endDate          = new Date();
  endDate.setMonth(endDate.getMonth() + durationMonths);
  const responseDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  // CRITICAL PATH — create subscription
  const subRef = await db.collection('subscriptions').add({
    host_id:                 hostId,
    rider_id:                uid,
    status:                  'pending',
    monthly_price:           monthlyPrice,
    duration_months:         durationMonths,
    pickup_stop:             pickupStop ?? '',
    base_amount:             baseAmount,
    service_fee:             serviceFee,
    total_amount:            totalAmount,
    host_earning:            hostEarning,
    paystack_reference:      reference,
    paystack_authorization:  auth.authorization_code,
    rider_billing_email:     riderEmail,
    response_deadline:       responseDeadline,
    start_date:              startDate.toISOString(),
    end_date:                endDate.toISOString(),
    no_show_count:           0,
    created_at:              FieldValue.serverTimestamp(),
  });

  // NON-CRITICAL — enqueue all notifications and emails
  await Promise.all([
    enqueue('send_notification', {
      type:   'payment_confirmed',
      userId: uid,
      token:  rider?.expo_push_token ?? null,
      amount: totalAmount,
    }),
    
    enqueue('send_email', {
      type:           'payment_confirmation',
      to:             riderEmail,
      riderName:      rider?.name ?? '',
      amount:         totalAmount,
      reference,
      hostName:       host?.name ?? 'your host',
      durationMonths,
    }),

    enqueue('send_notification', {
      type:           'new_request',
      userId:         hostId,
      token:          host?.expo_push_token ?? null,
      riderName:      rider?.name ?? 'A rider',
      durationMonths,
    }),

    host?.email && enqueue('send_email', {
      type:           'ride_request',
      to:             host.email,
      hostName:       host.name ?? '',
      riderName:      rider?.name ?? '',
      pickupStop:     pickupStop ?? '—',
      durationMonths,
      totalAmount,
      deadline:       responseDeadline,
      gender:       rider?.gender ?? '',
      company:      rider?.company_name ?? ''
    }),
  ]);

  logger.info('payment_verified', {
    subscriptionId: subRef.id,
    riderId:        uid,
    hostId,
    totalAmount,
    reference,
  });

  return NextResponse.json({
    verified:          true,
    authorizationCode: auth.authorization_code,
    subscriptionId:    subRef.id,
  });
}

export const POST = withApiLogging('verify-payment', handler as any);