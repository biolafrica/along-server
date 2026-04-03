import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // Vercel cron passes this header — protects against public access
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date().toISOString();

  const expiredSnap = await db.collection('subscriptions')
    .where('status',   '==', 'active')
    .where('end_date', '<=', now)
    .get();

  if (expiredSnap.empty) {
    return NextResponse.json({ processed: 0 });
  }

  const results: string[] = [];

  for (const subDoc of expiredSnap.docs) {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_APP_URL}/api/complete-subscription`,
        {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'x-internal-secret': process.env.INTERNAL_SECRET!,
          },
          body: JSON.stringify({ subscriptionId: subDoc.id }),
        }
      );
      const data = await res.json();
      results.push(`${subDoc.id}: ${data.result ?? data.message}`);
    } catch (err: any) {
      results.push(`${subDoc.id}: ERROR ${err.message}`);
    }
  }

  console.log('[cron/complete-expired] Results:', results);
  return NextResponse.json({ processed: expiredSnap.size, results });
}