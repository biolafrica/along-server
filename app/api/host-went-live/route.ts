import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);

  const hostDoc = await dbOperation('firestore_read', 'hosts', uid, () =>
    db.collection('hosts').doc(uid).get()
  );

  if (!hostDoc.exists) {
    return NextResponse.json({ message: 'Host profile not found' }, { status: 404 });
  }

  const userDoc  = await dbOperation('firestore_read', 'users', uid, () =>
    db.collection('users').doc(uid).get()
  );
  const userData = userDoc.data();

  if (!userData?.work_lat || !userData?.work_lng) {
    return NextResponse.json({ message: 'Host has no work location' }, { status: 400 });
  }

  // CRITICAL PATH — update Firestore immediately
  await dbOperation('firestore_write', 'hosts', uid, () =>
    db.collection('hosts').doc(uid).update({ is_live: true })
  );

  // NON-CRITICAL — alert matching riders in background
  await enqueue('sync_host_live_status', { hostId: uid });

  logger.info('host_went_live', { hostId: uid });

  // Fast response — background work already queued
  return NextResponse.json({ success: true });
}

export const POST = withApiLogging('host-went-live', handler as any);