import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';
import crypto from 'crypto';

const TERMII_BASE = 'https://v3.api.termii.com/api';
const TERMII_KEY  = process.env.TERMII_API_KEY!;

const OTP_TTL_MS  = 10 * 60 * 1000;
const OTP_LENGTH  = 6;

async function handler(req: NextRequest): Promise<NextResponse> {
  const { phone } = await req.json();

  if (!phone) {
    return NextResponse.json({ message: 'Phone number required' }, { status: 400 });
  }

  // Normalise to E.164 — strip leading 0, add +234
  const normalised = normaliseNigerianPhone(phone);
  if (!normalised) {
    return NextResponse.json({ message: 'Invalid Nigerian phone number' }, { status: 400 });
  }
  console.log("normalized number", normalised)

  // Generate a secure 6-digit OTP
  const otp       = generateOTP();
  console.log("otp", otp)
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  console.log("expiresAt", expiresAt)

  // Hash it before storing — never store raw OTPs
  const otpHash   = hashOTP(otp);
  console.log("hash", otpHash)



  // Store hashed OTP against the phone number
  // We use phone as the doc ID so there's only ever one pending OTP per number
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

  console.log('savedData', savedData)

  // Send via Termii — try WhatsApp first, fall back to SMS
  const sent = await sendViaTermii(normalised, otp);
  console.log('sent', sent)

  if (!sent.success) {
    //logger.error('otp_send_failed', new Error(sent.error ?? 'Termii error'), { phone: normalised });
    return NextResponse.json({ message: 'Failed to send OTP. Please try again.' }, { status: 500 });
  }

  //logger.info('otp_sent', { phone: normalised, channel: sent.channel });
  return NextResponse.json({ sent: true, channel: sent.channel });
}

// ─── Termii integration ───────────────────────────────────────────────────────

async function sendViaTermii(
  phone: string,
  otp:   string,
): Promise<{ success: boolean; channel?: string; error?: string }> {

  const message = `Your Along verification code is: ${otp}. Valid for 10 minutes. Do not share this with anyone.`;

  // Try WhatsApp first — higher delivery rate in Nigeria
  try {
    const waRes = await fetch(`${TERMII_BASE}/sms/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:          phone,
        from:        'Along',
        sms:         message,
        type:        'plain',
        channel:     'whatsapp',
        api_key:     TERMII_KEY,
      }),
    });

    const waData = await waRes.json();

    if (waRes.ok && waData.code === 'ok') {
      return { success: true, channel: 'whatsapp' };
    }
  } catch (err: any) {
    logger.warn('termii_whatsapp_failed', { phone, error: err.message });
  }

  // WhatsApp failed — fall back to SMS via DND-compliant route
  try {
    const smsRes = await fetch(`${TERMII_BASE}/sms/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:      phone,
        from:    'N-Alert',     // DND-exempt sender ID for Nigerian numbers
        sms:     message,
        type:    'plain',
        channel: 'dnd',         // DND route bypasses Do Not Disturb registration
        api_key: TERMII_KEY,
      }),
    });

    const smsData = await smsRes.json();

    if (smsRes.ok && smsData.code === 'ok') {
      return { success: true, channel: 'sms' };
    }

    return { success: false, error: smsData.message ?? 'SMS failed' };

  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseNigerianPhone(raw: string): string | null {
  // Remove all non-digits
  const digits = raw.replace(/\D/g, '');

  if (digits.startsWith('234') && digits.length === 13) return `+${digits}`;
  if (digits.startsWith('0')   && digits.length === 11)  return `+234${digits.slice(1)}`;
  if (digits.length === 10)                               return `+234${digits}`;

  return null;
}

function generateOTP(): string {
  // Cryptographically random 6-digit number
  const num = crypto.randomInt(0, 1_000_000);
  return String(num).padStart(OTP_LENGTH, '0');
}

function hashOTP(otp: string): string {
  return crypto
    .createHmac('sha256', process.env.OTP_HASH_SECRET!)
    .update(otp)
    .digest('hex');
}

export const POST = withApiLogging('send-otp', handler as any);