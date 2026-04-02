import { NextRequest, NextResponse } from 'next/server';
import { paystackGet } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { sendPaymentConfirmationEmail, sendRideRequestEmail } from '@/lib/email';
import { notifyPaymentReceived, notifyNewRideRequest } from '@/lib/notification';

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { reference } = await req.json();

    if (!reference) {
      return NextResponse.json({ message: 'Reference required' }, { status: 400 });
    }

    const data = await paystackGet(`/transaction/verify/${reference}`);
    console.log('[verify-payment] Paystack response:', data);

    if (data.data.status !== 'success') {
      return NextResponse.json({ message: 'Payment was not successful' }, { status: 402 });
    }

    const txn  = data.data;
    const auth = txn.authorization;

    const meta           = txn.metadata ?? {};
    const hostId         = meta.host_id         as string;
    const durationMonths = Number(meta.duration_months ?? 1);
    const pickupStop     = meta.pickup_stop      as string ?? '';
    const monthlyPrice   = Number(meta.monthly_price ?? 0);
    const riderEmail     = txn.customer.email    as string;
 
    if (!hostId) {
      return NextResponse.json({ message: 'Invalid payment metadata — host_id missing' }, { status: 400 });
    }

    // ── 2. Store authorization on user doc ────────────────────────────────────
    // CRITICAL: store the exact email used — Paystack requires same email
    // to charge this authorization_code again in future months.
    await db.collection('users').doc(uid).update({
      paystack_authorization_code: auth.authorization_code,
      paystack_email:              txn.customer.email,
      paystack_card_last4:         auth.last4,
      paystack_card_brand:         auth.brand,
      paystack_card_bank:          auth.bank,
    });

    // ── 3. Fetch rider and host data for notification ─────────────────────────
    const [riderDoc, hostDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(hostId).get(),
    ]);
    const rider = riderDoc.data();
    const host  = hostDoc.data();
    console.log('[verify-payment] Rider:', rider);

    // ── 4. Create subscription document as 'pending' ─────────────────────────
    const SERVICE_FEE_RATE = 0.10;
    const baseAmount       = monthlyPrice * durationMonths;
    const serviceFee       = Math.round(baseAmount * SERVICE_FEE_RATE);
    const totalAmount      = baseAmount + serviceFee;
    const hostEarning      = baseAmount;

    const startDate       = new Date();
    const endDate         = new Date();
    endDate.setMonth(endDate.getMonth() + durationMonths);

    // 48-hour deadline for host to respond
    const responseDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    console.log('[verify-payment] Creating subscription with:', {
      hostId,
      riderId: uid,
      monthlyPrice,
      durationMonths,
      pickupStop,
      baseAmount,
      serviceFee,
      totalAmount,
      hostEarning,
      reference,
      authCode: auth.authorization_code,
      riderEmail,
      responseDeadline,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    })


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

    console.log('[verify-payment] Created subscription:', subRef);

    // ── 5. Notify both parties — fire and forget ──────────────────────────────
    const deadline = responseDeadline;
    console.log('[verify-payment] Notifying parties...');
    await Promise.all([
      // Rider: payment received
      notifyPaymentReceived(rider?.expo_push_token, totalAmount),
      sendPaymentConfirmationEmail({
        to:             riderEmail,
        riderName:      rider?.name ?? '',
        amount:         totalAmount,
        reference,
        hostName:       host?.name ?? 'your host',
        durationMonths,
      }),
      // Host: new request
      notifyNewRideRequest(host?.expo_push_token, rider?.name ?? 'A rider', durationMonths),
      sendRideRequestEmail({
        to:             host?.paystack_email ?? host?.work_email ?? '',
        hostName:       host?.name ?? '',
        riderName:      rider?.name ?? '',
        pickupStop:     pickupStop ?? '—',
        durationMonths,
        totalAmount,
        deadline,
      }),
    ]);

    return NextResponse.json({
      verified:          true,
      authorizationCode: auth.authorization_code,
      subscriptionId:    subRef.id,
    });

  } catch (err: any) {
    console.error('[verify-payment]', err);
    const status = err.message?.includes('Authorization') ? 401 : 500;
    return NextResponse.json({ message: err.message }, { status });
  }
}