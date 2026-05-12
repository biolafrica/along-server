import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';
import { generateOTP, hashOTP, normaliseNigerianPhone } from '@/utils/otp';

const TERMII_BASE = 'https://v3.api.termii.com/api';
const TERMII_KEY  = process.env.TERMII_API_KEY!;

const OTP_TTL_MS  = 10 * 60 * 1000;


async function handler(req: NextRequest): Promise<NextResponse> {
  const { phone } = await req.json();
  if (!phone) {
    return NextResponse.json({ message: 'Phone number required' }, { status: 400 });
  }

  const normalised = normaliseNigerianPhone(phone);
  if (!normalised) {
    return NextResponse.json({ message: 'Invalid Nigerian phone number' }, { status: 400 });
  }

  const otp  = generateOTP();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  const otpHash   = hashOTP(otp);

  //use phone as the doc ID so there's only ever one pending OTP per number
  const otpRef = db.collection('otp_sessions').doc(normalised);
  const savedData = await dbOperation('firestore_write', 'otp_sessions', normalised, () =>
    otpRef.set({
      phone:      normalised,
      otp_hash:   otpHash,
      expires_at: expiresAt,
      attempts:   0,
      created_at: new Date().toISOString(),
    })
  );

  const sent = await sendViaTermii(normalised, otp);

  if (!sent.success) {
    logger.error('otp_send_failed', new Error(sent.error ?? 'Termii error'), { phone: normalised });
    return NextResponse.json({ message: 'Failed to send OTP. Please try again.' }, { status: 500 });
  }

  logger.info('otp_sent', { phone: normalised, channel: sent.channel });
  return NextResponse.json({ sent: true, channel: sent.channel });
}

async function sendViaTermii(
  phone: string,
  otp:   string,
): Promise<{ success: boolean; channel?: string; error?: string }> {

  const message = `Your Along verification code is: ${otp}. Valid for 10 minutes. Do not share this with anyone.`;

  // Try SMS via DND route first
  try {
    const smsRes = await fetch(`${TERMII_BASE}/sms/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      phone,
        from:    'N-Alert',
        sms:     message,
        type:    'plain',
        channel: 'dnd',
        api_key: TERMII_KEY,
      }),
    });

    const smsData = await smsRes.json();

    if (smsRes.ok && smsData.code === 'ok') {
      return { success: true, channel: 'sms' };
    }

    logger.warn('termii_sms_failed', { phone, response: smsData });

  } catch (err: any) {
    logger.warn('termii_sms_error', { phone, error: err.message });
  }

  // WhatsApp fallback — only if SMS fails
  try {
    const waRes = await fetch(`${TERMII_BASE}/sms/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      phone,
        from:    'Along',
        sms:     message,
        type:    'plain',
        channel: 'whatsapp',
        api_key: TERMII_KEY,
      }),
    });

    const waData = await waRes.json();

    if (waRes.ok && waData.code === 'ok') {
      return { success: true, channel: 'whatsapp' };
    }

    return { success: false, error: waData.message ?? 'All channels failed' };

  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export const POST = withApiLogging('send-otp', handler as any);