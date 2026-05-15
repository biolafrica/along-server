import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';
import crypto from 'crypto';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);
const FROM   = 'Usealong <notifications@usealong.co>';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { workEmail, companyName } = await req.json();

  if (!workEmail) {
    return NextResponse.json({ message: 'Work email required' }, { status: 400 });
  }

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Store token on user doc
  await dbOperation('firestore_write', 'users', uid, () =>
    db.collection('users').doc(uid).update({
      verification_token:            token,
      verification_token_expires_at: expiresAt,
      verification_token_email:      workEmail.trim().toLowerCase(),
    })
  );

  const verifyUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/verify-workplace?token=${token}&uid=${uid}`;

  // Direct Resend call — not queued, must be immediate
  await resend.emails.send({
    from:    FROM,
    to:      workEmail,
    subject: 'Verify your workplace for Usealong',
    html:    buildEmail(companyName ?? 'Usealong', verifyUrl),
  });

  logger.info('verification_email_sent', { uid, workEmail });
  return NextResponse.json({ sent: true });
}

export const POST = withApiLogging('send-verification-email', handler as any);

function buildEmail(companyName: string, verifyUrl: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f0;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
      <tr><td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;
          border-radius:16px;overflow:hidden;border:1px solid #e8e8e0;">
          <tr><td style="background:#14A08A;padding:24px 32px;">
            <span style="color:#fff;font-size:20px;font-weight:600;">Usealong</span>
          </td></tr>
          <tr><td style="padding:32px;">
            <h2 style="margin:0 0 16px;font-size:22px;font-weight:600;color:#1a1a18;">
              Verify your workplace
            </h2>
            <div style="font-size:15px;line-height:1.7;color:#5a5a55;">
              <p>Click the button below to confirm you work at <strong>${companyName}</strong>
              and complete your Usealong account verification.</p>
              <p>This link expires in <strong>24 hours</strong>.</p>
            </div>
            <div style="text-align:center;margin:32px 0;">
              <a href="${verifyUrl}"
                 style="background:#14A08A;color:#fff;padding:14px 28px;border-radius:100px;
                        text-decoration:none;font-weight:500;font-size:15px;display:inline-block;">
                Verify workplace
              </a>
            </div>
            <p style="font-size:13px;color:#8a8a85;">
              If you didn't create an Usealong account, you can safely ignore this email.
            </p>
          </td></tr>
          <tr><td style="padding:20px 32px;background:#f5f5f0;border-top:1px solid #e8e8e0;">
            <p style="margin:0;font-size:12px;color:#8a8a85;">
              Usealong — Commute with people you trust.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;
}