import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { enqueue } from '@/lib/queue';
import { logger, withApiLogging, dbOperation } from '@/lib/logger';

async function handler(req: NextRequest): Promise<NextResponse> {
  const uid = await verifyToken(req);
  const { chatId, text } = await req.json();

  if (!chatId || !text?.trim()) {
    return NextResponse.json({ message: 'Missing chatId or text' }, { status: 400 });
  }

  const chatRef  = db.collection('chats').doc(chatId);
  const chatSnap = await dbOperation('firestore_read', 'chats', chatId, () =>
    chatRef.get()
  );

  if (!chatSnap.exists) {
    return NextResponse.json({ message: 'Chat not found' }, { status: 404 });
  }

  const chat       = chatSnap.data()!;
  const isHost     = chat.host_id  === uid;
  const isRider    = chat.rider_id === uid;

  if (!isHost && !isRider) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 403 });
  }

  const recipientId = isHost ? chat.rider_id : chat.host_id;
  const unreadField = isHost ? 'unread_rider' : 'unread_host';
  const trimmedText = text.trim();
  const now         = new Date().toISOString();

  // CRITICAL PATH — write message + update chat
  await Promise.all([
    dbOperation('firestore_write', 'messages', chatId, () =>
      db.collection('chats').doc(chatId).collection('messages').add({
        chat_id:    chatId,
        sender_id:  uid,
        text:       trimmedText,
        created_at: FieldValue.serverTimestamp(),
        read:       false,
      })
    ),
    dbOperation('firestore_write', 'chats', chatId, () =>
      chatRef.update({
        last_message:    trimmedText,
        last_message_at: now,
        [unreadField]:   (chat[unreadField] ?? 0) + 1,
      })
    ),
  ]);

  const [senderDoc, recipientDoc] = await Promise.all([
    dbOperation('firestore_read', 'users', uid, () =>
      db.collection('users').doc(uid).get()
    ),
    dbOperation('firestore_read', 'users', recipientId, () =>
      db.collection('users').doc(recipientId).get()
    ),
  ]);

  const senderName = senderDoc.data()?.name ?? 'Someone';
  const recipToken = recipientDoc.data()?.expo_push_token ?? null;
  const preview    = trimmedText.length > 60 ? trimmedText.slice(0, 57) + '...' : trimmedText;

  // NON-CRITICAL — enqueue push
  await enqueue('send_notification', {
    type:       'new_message',
    userId:     recipientId,
    token:      recipToken,
    senderName,
    preview,
    chatId,
  });

  logger.info('message_sent', { chatId, senderId: uid, recipientId });
  return NextResponse.json({ sent: true });
}

export const POST = withApiLogging('send-message', handler as any);