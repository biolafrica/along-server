'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function VerifyContent() {
  const searchParams = useSearchParams();
  const status       = searchParams.get('status') as 'success' | 'error' | null;
  const detail       = searchParams.get('detail') ?? '';
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    const deepLink = `along://verify?status=${status}&detail=${encodeURIComponent(detail)}`;
    window.location.href = deepLink;

    // Mark as attempted after a short delay
    const timer = setTimeout(() => setAttempted(true), 1500);
    return () => clearTimeout(timer);
  }, [status, detail]);

  const isSuccess = status === 'success';

  return (
    <main style={{
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', margin: 0, background: '#f5f5f0', padding: '20px',
      boxSizing: 'border-box',
    }}>
      <div style={{
        background: 'white', borderRadius: '16px', padding: '40px',
        textAlign: 'center', maxWidth: '400px', width: '100%',
        boxShadow: '0 2px 16px rgba(0,0,0,0.08)',
      }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>
          {isSuccess ? '✅' : '❌'}
        </div>

        <h2 style={{ color: '#1a1a18', margin: '0 0 8px', fontSize: '22px', fontWeight: 600 }}>
          {isSuccess ? 'Workplace verified!' : 'Verification failed'}
        </h2>

        <p style={{ color: '#5a5a55', margin: '0 0 24px', fontSize: '15px', lineHeight: 1.6 }}>
          {isSuccess
            ? 'Your workplace has been verified. Open Usealong to continue.'
            : decodeURIComponent(detail)}
        </p>

        {/* Primary CTA — open app */}
        
        <a  href={`along://verify?status=${status}&detail=${encodeURIComponent(detail)}`}
          style={{
            display: 'inline-block', background: '#14A08A', color: 'white',
            padding: '12px 28px', borderRadius: '100px', textDecoration: 'none',
            fontWeight: 500, fontSize: '15px', marginBottom: '16px',
          }}
        >
          Open Usealong
        </a>

        {attempted && (
          <p style={{ color: '#8a8a85', fontSize: '13px', margin: '16px 0 0' }}>
            Don&apos;t have Usealong yet?{' '}
            
            <a  href="https://apps.apple.com/app/usealong"
              style={{ color: '#14A08A', textDecoration: 'none' }}
            >
              Download on iOS
            </a>
            {' · '}
            <a
              href="https://play.google.com/store/apps/details?id=com.abiodun.usealong"
              style={{ color: '#14A08A', textDecoration: 'none' }}
            >
              Android
            </a>
          </p>
        )}
      </div>
    </main>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyContent />
    </Suspense>
  );
}