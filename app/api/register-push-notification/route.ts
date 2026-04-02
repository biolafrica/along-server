import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';

export async function POST(req: NextRequest) {
  try {
    const uid   = await verifyToken(req);
    const { token } = await req.json();

    if (!token || !token.startsWith('ExponentPushToken')) {
      return NextResponse.json({ message: 'Invalid push token' }, { status: 400 });
    }

    await db.collection('users').doc(uid).update({ expo_push_token: token });
    return NextResponse.json({ success: true });

  } catch (err: any) {
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}