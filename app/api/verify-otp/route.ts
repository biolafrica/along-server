import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';
import { hashOTP, normaliseNigerianPhone } from '@/utils/otp';

const MAX_ATTEMPTS = 5; 
const OTP_LENGTH   = 6;

async function handler(req: NextRequest): Promise<NextResponse> {
  const { phone, otp } = await req.json();

  if (!phone || !otp) {
    return NextResponse.json({ message: 'Phone and OTP required' }, { status: 400 });
  }

  if (otp.length !== OTP_LENGTH || !/^\d+$/.test(otp)) {
    return NextResponse.json({ message: 'Invalid OTP format' }, { status: 400 });
  }

  const normalised = normaliseNigerianPhone(phone);
  if (!normalised) {
    return NextResponse.json({ message: 'Invalid phone number' }, { status: 400 });
  }

  const otpRef  = db.collection('otp_sessions').doc(normalised);
  const otpSnap = await dbOperation('firestore_read', 'otp_sessions', normalised, () =>
    otpRef.get()
  );

  if (!otpSnap.exists) {
    return NextResponse.json({ message: 'No OTP found. Please request a new code.' }, { status: 404 });
  }

  const session = otpSnap.data()!;

  // ── Check expiry
  if (new Date() > new Date(session.expires_at)) {
    await otpRef.delete();
    return NextResponse.json({ message: 'OTP expired. Please request a new code.' }, { status: 410 });
  }

  // ── Check attempt limit
  if (session.attempts >= MAX_ATTEMPTS) {
    await otpRef.delete();
    return NextResponse.json({
      message: 'Too many incorrect attempts. Please request a new code.',
    }, { status: 429 });
  }

  // ── Verify OTP hash 
  const submittedHash = hashOTP(otp);

  if (submittedHash !== session.otp_hash) {
    // Increment attempts
    await otpRef.update({ attempts: FieldValue.increment(1) });
    const remaining = MAX_ATTEMPTS - (session.attempts + 1);
    logger.warn('otp_wrong_code', { phone: normalised, attempts: session.attempts + 1 });
    return NextResponse.json({
      message:   `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
      remaining,
    }, { status: 401 });
  }

  // ── OTP correct: delete session 
  await otpRef.delete();

  // Find or create Firebase user for this phone number 
  let uid: string;
  let isNewUser = false;

  try {
    const existingUser = await auth.getUserByPhoneNumber(normalised);
    uid = existingUser.uid;
  } catch {
    const newUser = await auth.createUser({ phoneNumber: normalised });
    uid       = newUser.uid;
    isNewUser = true;
  }

  // Check if user has a Firestore profile 
  const userSnap = await dbOperation('firestore_read', 'users', uid, () =>
    db.collection('users').doc(uid).get()
  );

  const hasProfile       = userSnap.exists;
  const registrationStage = userSnap.data()?.registration_stage ?? null;

  // ── Create Firebase custom token ──────────────────────────────────────────
  const customToken = await auth.createCustomToken(uid, {
    phone: normalised,  // extra claims available in security rules if needed
  });

  logger.info('otp_verified', {
    uid,
    phone:   normalised,
    isNewUser,
    hasProfile,
    registrationStage,
  });

  return NextResponse.json({
    customToken,
    uid,
    // These tell the app what state the user is in so it can route correctly
    isNewUser,          // true = never registered, show account type selection
    hasProfile,         // false = started registration but never completed profile
    registrationStage,  // 'profile' | 'workplace' | 'addresses' | etc — current stage
  });
}



export const POST = withApiLogging('verify-otp', handler as any);