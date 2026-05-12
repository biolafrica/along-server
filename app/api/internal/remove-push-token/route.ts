import { db } from "@/lib/firebase-admin";
import { withApiLogging } from "@/lib/logger";
import { FieldValue } from "firebase-admin/firestore";
import { NextRequest, NextResponse } from "next/server";

async function handler(req: NextRequest) {
  const { uid, token } = await req.json();
  await db.collection('users').doc(uid).update({
    expo_push_tokens: FieldValue.arrayRemove(token)
  });
  return NextResponse.json({ success: true });
}

export const POST = withApiLogging('remove-stale-token', handler as any);