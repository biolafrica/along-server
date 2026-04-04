import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { notifyHostOnline } from '@/lib/notification';
import { sendHostOnlineEmail } from '@/lib/email';

// implement trigger when admin verify a host.

const MAX_WORK_DISTANCE_KM = 3.0;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);

    const hostDoc  = await db.collection('hosts').doc(uid).get();
    if (!hostDoc.exists) {
      return NextResponse.json({ message: 'Host profile not found' }, { status: 404 });
    }

    const userDoc  = await db.collection('users').doc(uid).get();
    const userData = userDoc.data();

    if (!userData?.work_lat || !userData?.work_lng) {
      return NextResponse.json({ message: 'Host has no work location' }, { status: 400 });
    }

    const hostData     = hostDoc.data()!;
    const hostName     = userData.name    ?? 'A host';
    const monthlyPrice = hostData.monthly_price ?? 0;
    const routeLabel   = `${userData.home_address?.split(',')[0] ?? '—'} → ${userData.work_address?.split(',')[0] ?? '—'}`;

    // Fetch all active route alerts
    const alertsSnap = await db.collection('route_alerts')
      .where('active', '==', true)
      .get();

    if (alertsSnap.empty) {
      return NextResponse.json({ notified: 0 });
    }

    // Filter alerts where rider's work location is near host's work location
    const matchingAlerts = alertsSnap.docs.filter(alertDoc => {
      const alert = alertDoc.data();
      if (!alert.work_lat || !alert.work_lng) return false;
      const dist = haversineKm(
        userData.work_lat, userData.work_lng,
        alert.work_lat,    alert.work_lng,
      );
      return dist <= MAX_WORK_DISTANCE_KM;
    });

    if (matchingAlerts.length === 0) {
      return NextResponse.json({ notified: 0 });
    }

    // Fetch rider tokens and emails
    const riderIds  = matchingAlerts.map(d => d.data().rider_id);
    const riderDocs = await Promise.all(
      riderIds.map(id => db.collection('users').doc(id).get())
    );

    const users = riderDocs
      .map(d => d.exists ? d.data() : null)
      .filter(Boolean) as FirebaseFirestore.DocumentData[];

    const tokens = users.map(u => u.expo_push_token ?? null);
    const emails = users.map(u => u.email).filter(Boolean) as string[];

    // Send notifications
    await Promise.all([
      notifyHostOnline(
        riderIds.map((id, i) => ({ userId: id, token: tokens[i] })),
        hostName,
        monthlyPrice,
      ),
      ...emails.map(email =>
        sendHostOnlineEmail({
          to:           [email],
          hostName,
          routeLabel,
          monthlyPrice,
        })
      ),
    ]);

    console.log(`[host-went-live] Notified ${matchingAlerts.length} riders for host ${uid}`);
    return NextResponse.json({ notified: matchingAlerts.length });

  } catch (err: any) {
    console.error('[host-went-live]', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}