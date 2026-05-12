import crypto from 'crypto';

const OTP_LENGTH  = 6;

export function normaliseNigerianPhone(raw: string): string | null {
  // Remove all non-digits
  const digits = raw.replace(/\D/g, '');

  if (digits.startsWith('234') && digits.length === 13) return `+${digits}`;
  if (digits.startsWith('0')   && digits.length === 11)  return `+234${digits.slice(1)}`;
  if (digits.length === 10)                               return `+234${digits}`;

  return null;
}

export function generateOTP(): string {
  // Cryptographically random 6-digit number
  const num = crypto.randomInt(0, 1_000_000);
  return String(num).padStart(OTP_LENGTH, '0');
}

export function hashOTP(otp: string): string {
  return crypto
  .createHmac('sha256', process.env.OTP_HASH_SECRET!)
  .update(otp)
  .digest('hex');
}