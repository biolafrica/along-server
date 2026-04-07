import { NextRequest, NextResponse } from 'next/server';
import { paystackGet } from '@/lib/paystack';
import { logger, withApiLogging } from '@/lib/logger';

let cachedBanks: { name: string; code: string }[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function handler(_req: NextRequest): Promise<NextResponse> {
  const now = Date.now();

  if (cachedBanks && now - cacheTime < CACHE_TTL_MS) {
    return NextResponse.json({ banks: cachedBanks });
  }

  const res = await paystackGet('/bank?country=nigeria&perPage=100&use_cursor=false');

  if (!res.status) {
    logger.error('get_banks_failed', new Error(res.message ?? 'Paystack error'), {});
    return NextResponse.json({ message: 'Failed to fetch banks' }, { status: 500 });
  }

  cachedBanks = res.data.map((b: any) => ({ name: b.name, code: b.code }));
  cacheTime   = now;

  logger.info('banks_fetched', { count: cachedBanks!.length });
  return NextResponse.json({ banks: cachedBanks });
}

export const GET = withApiLogging('get-banks', handler as any);