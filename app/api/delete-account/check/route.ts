import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { logger, withApiLogging } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);

  const riderSub = await db.collection('subscriptions')
  .where('rider_id', '==', uid)
  .where('status', 'in', ['active', 'pending'])
  .limit(1)
  .get();

  if (!riderSub.empty) {
    const status = riderSub.docs[0].data().status;
    return NextResponse.json({
      eligible: false,
      code:     'HAS_ACTIVE_SUBSCRIPTION',
      message:  status === 'active'
        ? 'You have an active subscription.'
        : 'You have a pending ride request.',
    }, { status: 409 });
  }

  const hostSub = await db.collection('subscriptions')
  .where('host_id', '==', uid)
  .where('status', 'in', ['active', 'pending'])
  .limit(1)
  .get();

  if (!hostSub.empty) {
    return NextResponse.json({
      eligible: false,
      code:     'HAS_ACTIVE_RIDERS',
      message:  'You have active riders on your subscription.',
    }, { status: 409 });
  }

  logger.info('delete_account_check_passed', { userId: uid });
  return NextResponse.json({ eligible: true });
}

export const GET = withApiLogging('delete-account-check', handler as any);