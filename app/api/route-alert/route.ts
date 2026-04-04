import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';


export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { workLat, workLng, workLabel, homeLat, homeLng, homeLabel } = await req.json();

    if (!workLat || !workLng) {
      return NextResponse.json({ message: 'Missing location data' }, { status: 400 });
    }

    // Check if alert already exists for this rider — one alert per rider
    const existing = await db.collection('route_alerts')
      .where('rider_id', '==', uid)
      .limit(1)
      .get();

    if (!existing.empty) {
      // Update existing alert
      await existing.docs[0].ref.update({
        work_lat:   workLat,
        work_lng:   workLng,
        work_label: workLabel ?? '',
        home_lat:   homeLat  ?? null,
        home_lng:   homeLng  ?? null,
        home_label: homeLabel ?? '',
        updated_at: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({ alertId: existing.docs[0].id, updated: true });
    }

    const alertRef = await db.collection('route_alerts').add({
      rider_id:   uid,
      work_lat:   workLat,
      work_lng:   workLng,
      work_label: workLabel ?? '',
      home_lat:   homeLat  ?? null,
      home_lng:   homeLng  ?? null,
      home_label: homeLabel ?? '',
      active:     true,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ alertId: alertRef.id, created: true });
  } catch (err: any) {
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const uid = await verifyToken(req);

    const existing = await db.collection('route_alerts')
      .where('rider_id', '==', uid)
      .limit(1)
      .get();

    if (existing.empty) {
      return NextResponse.json({ message: 'No alert found' }, { status: 404 });
    }

    await existing.docs[0].ref.delete();
    return NextResponse.json({ deleted: true });
  } catch (err: any) {
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}