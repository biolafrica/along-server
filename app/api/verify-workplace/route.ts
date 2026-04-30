import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, dbOperation } from '@/lib/logger';

const APP_URL = 'https://usealong.co';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');
  const uid   = searchParams.get('uid');

  if (!token || !uid) {
    return redirectToVerifyPage('error', 'Invalid verification link.');
  }

  try {
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await dbOperation('firestore_read', 'users', uid, () =>
      userRef.get()
    );

    if (!userSnap.exists) {
      return redirectToVerifyPage('error', 'Account not found.');
    }

    const user = userSnap.data()!;

    if (user.verification_token !== token) {
      return redirectToVerifyPage('error', 'Invalid or already used verification link.');
    }

    const expiresAt = new Date(user.verification_token_expires_at ?? 0);
    if (new Date() > expiresAt) {
      return redirectToVerifyPage('error', 'This verification link has expired. Please request a new one.');
    }

    if (user.verification_status === 'verified') {
      return redirectToVerifyPage('success', 'already_verified');
    }

    // CRITICAL PATH — mark verified
    await dbOperation('firestore_write', 'users', uid, () =>
      userRef.update({
        verification_status:           'verified',
        verified_at:                   FieldValue.serverTimestamp(),
        verification_token:            FieldValue.delete(),
        verification_token_expires_at: FieldValue.delete(),
        verification_token_email:      FieldValue.delete(),
      })
    );

    const accountType = user.account_type as 'host' | 'rider';

    // NON-CRITICAL — enqueue welcome notification + email
    await Promise.all([
      enqueue('send_notification', {
        type:        'account_verified',
        userId:      uid,
        token:       user.expo_push_token ?? null,
        accountType,
      }),
      user.email && enqueue('send_email', {
        type:        'welcome',
        to:          user.email,
        name:        user.name ?? '',
        accountType,
      }),
    ]);

    logger.info('workplace_verified', { uid, accountType });
    return redirectToVerifyPage('success', accountType);

  } catch (err: any) {
    logger.error('verify_workplace_failed', err, { uid });
    return redirectToVerifyPage('error', 'Something went wrong. Please try again.');
  }
}

function redirectToVerifyPage(status: 'success' | 'error', detail: string): NextResponse {
  const url = new URL(`${APP_URL}/verified`);
  url.searchParams.set('status', status);
  url.searchParams.set('detail', detail);
 
  return NextResponse.redirect(url.toString(), { status: 302 });
}