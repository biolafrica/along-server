import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { paystackGet, paystackPost } from '@/lib/paystack';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { accountNumber, bankCode, accountName, verifyOnly } = await req.json();

  if (!accountNumber || !bankCode) {
    return NextResponse.json({ message: 'Account number and bank code required' }, { status: 400 });
  }

  const verifyRes = await paystackGet(
    `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
  );

  if (!verifyRes.status) {
    logger.warn('bank_account_verify_failed', { uid, bankCode });
    return NextResponse.json({
      message: 'Could not verify account. Check the account number and bank.',
    }, { status: 400 });
  }

  const resolvedName = verifyRes.data?.account_name ?? accountName;

  if (verifyOnly) {
    return NextResponse.json({ accountName: resolvedName });
  }

  const userDoc  = await dbOperation('firestore_read', 'users', uid, () =>
    db.collection('users').doc(uid).get()
  );
  const userData = userDoc.data();

  if (userData?.paystack_recipient_code) {
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
    logger.error('bank_account_recipient_failed', new Error(recipientRes.message), { uid });
    return NextResponse.json({
      message: recipientRes.message ?? 'Failed to register bank account',
    }, { status: 500 });
  }

  const recipientCode = recipientRes.data?.recipient_code;

  await dbOperation('firestore_write', 'users', uid, () =>
    db.collection('users').doc(uid).update({
      bank_account_number:     accountNumber,
      bank_code:               bankCode,
      bank_account_name:       resolvedName,
      paystack_recipient_code: recipientCode,
      bank_account_updated_at: new Date().toISOString(),
    })
  );

  logger.info('bank_account_saved', { uid, bankCode });
  return NextResponse.json({ success: true, accountName: resolvedName, recipientCode });
}

export const POST = withApiLogging('save-bank-account', handler as any);