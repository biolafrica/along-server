import { NextResponse } from 'next/server';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://usealong.co';

export function redirectToApp(
  status: 'success' | 'error',
  detail: string
): NextResponse {
  // Use Universal Link — iOS/Android intercept this and open Along directly
  // If Along isn't installed, /verify page renders with download prompt
  const universalLink = `${APP_URL}/verify?status=${status}&detail=${encodeURIComponent(detail)}`;

  return new NextResponse(
    `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Usealong — Workplace Verification</title>
      <meta http-equiv="refresh" content="0;url=${universalLink}">
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
          ? 'Your workplace has been verified. Open Usealong to continue.'
          : decodeURIComponent(detail)}</p>
        <a href="${universalLink}">Open Usealong</a>
      </div>
    </body></html>`,
    {
      status:  302,
      headers: {
        'Content-Type': 'text/html',
        'Location':     universalLink,
      },
    }
  );
}