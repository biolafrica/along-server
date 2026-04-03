import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { paystackGet, paystackPost } from '@/lib/paystack';

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { accountNumber, bankCode, accountName, verifyOnly } = await req.json();

    if (!accountNumber || !bankCode) {
      return NextResponse.json({ message: 'Account number and bank code required' }, { status: 400 });
    }

    const verifyRes = await paystackGet(
      `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
    );

    if (!verifyRes.status) {
      return NextResponse.json({
        message: 'Could not verify account. Check the account number and bank.',
      }, { status: 400 });
    }

    const resolvedName = verifyRes.data?.account_name ?? accountName;

    if (verifyOnly) {
      return NextResponse.json({ accountName: resolvedName });
    }

    const userDoc  = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();

    if (userData?.paystack_recipient_code) {
      // Best effort — don't block on failure
      await paystackPost(`/transferrecipient/${userData.paystack_recipient_code}`, {})
        .catch(() => {});
    }

    const recipientRes = await paystackPost('/transferrecipient', {
      type:           'nuban',
      name:           resolvedName,
      account_number: accountNumber,
      bank_code:      bankCode,
      currency:       'NGN',
    });

    if (!recipientRes.status) {
      return NextResponse.json({
        message: recipientRes.message ?? 'Failed to register bank account',
      }, { status: 500 });
    }

    const recipientCode = recipientRes.data?.recipient_code;

    await db.collection('users').doc(uid).update({
      bank_account_number:       accountNumber,
      bank_code:                 bankCode,
      bank_account_name:         resolvedName,
      paystack_recipient_code:   recipientCode,
      bank_account_updated_at:   new Date().toISOString(),
    });

    return NextResponse.json({
      success:         true,
      accountName:     resolvedName,
      recipientCode,
    });

  } catch (err: any) {
    console.error('[save-bank-account]', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}