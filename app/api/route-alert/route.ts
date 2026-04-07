import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function postHandler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { workLat, workLng, workLabel, homeLat, homeLng, homeLabel } = await req.json();

  if (!workLat || !workLng) {
    return NextResponse.json({ message: 'Missing location data' }, { status: 400 });
  }

  const existing = await db.collection('route_alerts')
    .where('rider_id', '==', uid)
    .limit(1)
    .get();

  if (!existing.empty) {
    await dbOperation('firestore_write', 'route_alerts', existing.docs[0].id, () =>
      existing.docs[0].ref.update({
        work_lat:   workLat,
        work_lng:   workLng,
        work_label: workLabel ?? '',
        home_lat:   homeLat  ?? null,
        home_lng:   homeLng  ?? null,
        home_label: homeLabel ?? '',
        updated_at: FieldValue.serverTimestamp(),
      })
    );
    logger.info('route_alert_updated', { userId: uid, alertId: existing.docs[0].id });
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

  logger.info('route_alert_created', { userId: uid, alertId: alertRef.id });
  return NextResponse.json({ alertId: alertRef.id, created: true });
}

async function deleteHandler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);

  const existing = await db.collection('route_alerts')
    .where('rider_id', '==', uid)
    .limit(1)
    .get();

  if (existing.empty) {
    return NextResponse.json({ message: 'No alert found' }, { status: 404 });
  }

  await dbOperation('firestore_write', 'route_alerts', existing.docs[0].id, () =>
    existing.docs[0].ref.delete()
  );

  logger.info('route_alert_deleted', { userId: uid });
  return NextResponse.json({ deleted: true });
}

export const POST   = withApiLogging('route-alert-post',   postHandler   as any);
export const DELETE = withApiLogging('route-alert-delete', deleteHandler as any);