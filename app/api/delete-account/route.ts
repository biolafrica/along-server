import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db, auth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);

  const activeRiderSub = await db.collection('subscriptions')
  .where('rider_id', '==', uid)
  .where('status', 'in', ['active', 'pending'])
  .limit(1)
  .get();

  if (!activeRiderSub.empty) {
    const status = activeRiderSub.docs[0].data().status;
    return NextResponse.json({
      code:    'HAS_ACTIVE_SUBSCRIPTION',
      message: status === 'active'
        ? 'You have an active subscription. Please wait for it to end or contact support to cancel.'
        : 'You have a pending ride request. Please cancel it before deleting your account.',
    }, { status: 409 });
  }

  const activeHostSub = await db.collection('subscriptions')
  .where('host_id', '==', uid)
  .where('status', 'in', ['active', 'pending'])
  .limit(1)
  .get();

  if (!activeHostSub.empty) {
    return NextResponse.json({
      code:    'HAS_ACTIVE_RIDERS',
      message: 'You have active riders on your subscription. Your account cannot be deleted until all current subscriptions have ended.',
    }, { status: 409 });
  }

  const userSnap = await dbOperation('firestore_read', 'users', uid, () =>
    db.collection('users').doc(uid).get()
  );

  if (!userSnap.exists) {
    return NextResponse.json({ message: 'User not found' }, { status: 404 });
  }

  const userData = userSnap.data()!;

  // Disable login and revoke all existing sessions
  await auth.updateUser(uid, { disabled: true });
  await auth.revokeRefreshTokens(uid);

  // Soft delete — preserve record for audit trail, anonymise PII
  await dbOperation('firestore_write', 'users', uid, () =>
    db.collection('users').doc(uid).update({
      is_deleted:       true,
      deleted_at:       FieldValue.serverTimestamp(),
      name:             '[Deleted User]',
      email:            `deleted_${uid}@along.invalid`,
      phone:            null,
      photo_url:        null,
      expo_push_token:  null,
      home_address:     null,
      home_lat:         null,
      home_lng:         null,
      work_address:     null,
      work_lat:         null,
      work_lng:         null,
      paystack_authorization_code: null,
      paystack_recipient_code:     null,
      bank_account_number:         null,
      bank_account_name:           null,
    })
  );

  // ── 5. Send farewell email before PII is gone 
  if (userData.email) {
    await enqueue('send_email', {
      type: 'account_deleted',
      to:   userData.email,
      name: userData.name ?? '',
    }).catch(() => {}); // Non-fatal — account is already deleted
  }

  logger.info('account_deleted', {
    userId:      uid,
    accountType: userData.account_type,
  });

  return NextResponse.json({ deleted: true });
}

export const POST = withApiLogging('delete-account', handler as any);