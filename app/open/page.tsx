'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

// Screen → custom scheme path mapping
const SCREEN_MAP: Record<string, string> = {
  browse:           '(tabs)/rides',
  rides:            '(tabs)/rides',
  profile:          '(tabs)/profile',
  'payment-methods': '(tabs)/profile/payment-methods',
  home:             '(tabs)',
};

function OpenContent() {
  const searchParams = useSearchParams();
  const screen       = searchParams.get('screen') ?? 'home';
  const segment      = searchParams.get('segment') ?? '';

  // Build the deep link path with optional segment
  const path       = SCREEN_MAP[screen] ?? '(tabs)';
  const segParam   = segment ? `?segment=${encodeURIComponent(segment)}` : '';
  const deepLink   = `along://${path}${segParam}`;
  const intentLink = `intent://${path}${segParam}#Intent;scheme=along;package=com.abiodun.along;end`;

  useEffect(() => {
    const ua        = navigator.userAgent.toLowerCase();
    const isAndroid = ua.includes('android');
    const isIOS     = /iphone|ipad|ipod/.test(ua);

    if (isIOS)     window.location.href = deepLink;
    else if (isAndroid) window.location.href = intentLink;
  }, [deepLink, intentLink]);

  return (
    <main style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      minHeight:      '100vh',
      background:     '#f5f5f0',
      padding:        '20px',
    }}>
      <div style={{
        background:    'white',
        borderRadius:  '16px',
        padding:       '40px',
        textAlign:     'center',
        maxWidth:      '400px',
        width:         '100%',
        boxShadow:     '0 2px 16px rgba(0,0,0,0.08)',
      }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🚗</div>

        <h2 style={{ color: '#1a1a18', margin: '0 0 8px', fontSize: '22px', fontWeight: 600 }}>
          Open Usealong
        </h2>

        <p style={{ color: '#5a5a55', margin: '0 0 24px', fontSize: '15px', lineHeight: 1.6 }}>
          Usealong is a mobile app. Download it to continue.
        </p>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <a
            href="https://apps.apple.com/app/along"
            style={{
              display:        'inline-block',
              background:     '#14A08A',
              color:          'white',
              padding:        '12px 24px',
              borderRadius:   '100px',
              textDecoration: 'none',
              fontWeight:     500,
              fontSize:       '15px',
            }}
          >
            Download on iOS
          </a>
          <a
            href="https://play.google.com/store/apps/details?id=com.abiodun.along"
            style={{
              display:        'inline-block',
              background:     '#1a1a18',
              color:          'white',
              padding:        '12px 24px',
              borderRadius:   '100px',
              textDecoration: 'none',
              fontWeight:     500,
              fontSize:       '15px',
            }}
          >
            Get on Android
          </a>
        </div>
      </div>
    </main>
  );
}

export default function OpenPage() {
  return (
    <Suspense>
      <OpenContent />
    </Suspense>
  );
}