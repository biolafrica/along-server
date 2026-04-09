import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, dbOperation } from '@/lib/logger';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');
  const uid   = searchParams.get('uid');

  if (!token || !uid) {
    return redirectToApp('error', 'Invalid verification link.');
  }

  try {
    const userRef  = db.collection('users').doc(uid);
    const userSnap = await dbOperation('firestore_read', 'users', uid, () =>
      userRef.get()
    );

    if (!userSnap.exists) {
      return redirectToApp('error', 'Account not found.');
    }

    const user = userSnap.data()!;

    if (user.verification_token !== token) {
      return redirectToApp('error', 'Invalid or already used verification link.');
    }

    const expiresAt = new Date(user.verification_token_expires_at ?? 0);
    if (new Date() > expiresAt) {
      return redirectToApp('error', 'This verification link has expired. Please request a new one.');
    }

    if (user.verification_status === 'verified') {
      return redirectToApp('success', 'already_verified');
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
    return redirectToApp('success', accountType);

  } catch (err: any) {
    logger.error('verify_workplace_failed', err, { uid });
    return redirectToApp('error', 'Something went wrong. Please try again.');
  }
}

function redirectToApp(status: 'success' | 'error', detail: string): NextResponse {
  const appDeepLink = `along://verify?status=${status}&detail=${encodeURIComponent(detail)}`;

  return new NextResponse(
    `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Along — Workplace Verification</title>
      <meta http-equiv="refresh" content="0;url=${appDeepLink}">
      <style>
        body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
        justify-content: center; height: 100vh; margin: 0; background: #f5f5f0; }
        .card { background: white; border-radius: 16px; padding: 40px; text-align: center;
        max-width: 400px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h2 { color: #1a1a18; margin: 0 0 8px; }
        p  { color: #5a5a55; margin: 0 0 24px; }
        a  { background: #14A08A; color: white; padding: 12px 24px; border-radius: 100px;
        text-decoration: none; font-weight: 500; }
      </style>
    </head><body>
      <div class="card">
        <div class="icon">${status === 'success' ? '✅' : '❌'}</div>
        <h2>${status === 'success' ? 'Workplace verified!' : 'Verification failed'}</h2>
        <p>${status === 'success'
          ? 'Your workplace has been verified. Open Along to continue.'
          : decodeURIComponent(detail)}</p>
        <a href="${appDeepLink}">Open Along</a>
      </div>
    </body></html>`,
    {
      status:  302,
      headers: {
        'Content-Type': 'text/html',
        'Location':     appDeepLink,
      },
    }
  );
}