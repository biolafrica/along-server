import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';
 
async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { token } = await req.json();
 
  if (!token || !token.startsWith('ExponentPushToken')) {
    return NextResponse.json({ message: 'Invalid push token' }, { status: 400 });
  }
 
  await dbOperation('firestore_write', 'users', uid, () =>
    db.collection('users').doc(uid).set(
      { expo_push_token: token,}, { merge: true }
    )
  );
  
 
  logger.info('push_token_registered', { userId: uid });
  return NextResponse.json({ success: true });
}
 
export const POST = withApiLogging('register-push-token', handler as any);
