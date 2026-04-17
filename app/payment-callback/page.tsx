'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function PaymentCallbackContent() {
  const searchParams = useSearchParams();
  const reference    = searchParams.get('reference') ?? '';
  const trxref       = searchParams.get('trxref')    ?? reference;
  const [attempted, setAttempted]   = useState(false);

  useEffect(() => {
    // Open the app with the payment reference
    const deepLink = `along://payment-callback?reference=${encodeURIComponent(reference)}&trxref=${encodeURIComponent(trxref)}`;
    window.location.href = deepLink;

    const timer = setTimeout(() => setAttempted(true), 1500);
    return () => clearTimeout(timer);
  }, [reference, trxref]);

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
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>💳</div>

        <h2 style={{ color: '#1a1a18', margin: '0 0 8px', fontSize: '22px', fontWeight: 600 }}>
          Payment processing
        </h2>

        <p style={{ color: '#5a5a55', margin: '0 0 24px', fontSize: '15px', lineHeight: 1.6 }}>
          Opening Along to confirm your payment...
        </p>

        <a
          href={`along://payment-callback?reference=${encodeURIComponent(reference)}&trxref=${encodeURIComponent(trxref)}`}
          style={{
            display: 'inline-block', background: '#14A08A', color: 'white',
            padding: '12px 28px', borderRadius: '100px', textDecoration: 'none',
            fontWeight: 500, fontSize: '15px', marginBottom: '16px',
          }}
        >
          Open Along
        </a>

        {attempted && (
          <p style={{ color: '#8a8a85', fontSize: '13px', margin: '16px 0 0' }}>
            Don&apos;t have Along yet?{' '}
            <a
              href="https://apps.apple.com/app/along"
              style={{ color: '#14A08A', textDecoration: 'none' }}
            >
              Download on iOS
            </a>
            {' · '}
            <a
              href="https://play.google.com/store/apps/details?id=com.abiodun.along"
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

export default function PaymentCallbackPage() {
  return (
    <Suspense>
      <PaymentCallbackContent />
    </Suspense>
  );
}