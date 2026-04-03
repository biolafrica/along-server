import { NextRequest, NextResponse } from 'next/server';
import { paystackGet } from '@/lib/paystack';

let cachedBanks: { name: string; code: string }[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function GET(_req: NextRequest) {
  try {
    const now = Date.now();

    if (cachedBanks && now - cacheTime < CACHE_TTL_MS) {
      return NextResponse.json({ banks: cachedBanks });
    }

    const res = await paystackGet('/bank?country=nigeria&perPage=100&use_cursor=false');

    if (!res.status) {
      return NextResponse.json({ message: 'Failed to fetch banks' }, { status: 500 });
    }

    cachedBanks = res.data.map((b: any) => ({ name: b.name, code: b.code }));
    cacheTime   = now;

    return NextResponse.json({ banks: cachedBanks });

  } catch (err: any) {
    console.error('Error fetching banks:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}