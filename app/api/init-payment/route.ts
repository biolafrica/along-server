import { NextRequest, NextResponse } from 'next/server';
import { paystackPost } from '@/lib/paystack';
import { verifyToken } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);

    const { hostId, riderEmail, amountKobo, durationMonths, pickupStop, metadata } = await req.json();

    if (!riderEmail || !amountKobo || !hostId) {
      return NextResponse.json({ message: 'Missing required fields' }, { status: 400 });
    }

    const reference = `along_${uid}_${Date.now()}`;
    console.log(reference, hostId, riderEmail, amountKobo, durationMonths, pickupStop);

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

    return NextResponse.json({
      authUrl:   data.data.authorization_url,
      reference: data.data.reference,
    });

  } catch (err: any) {
    console.error('[init-payment]', err);
    const status = err.message?.includes('Authorization') ? 401 : 500;
    return NextResponse.json({ message: err.message }, { status });
  }
}