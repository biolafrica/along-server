import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import { db } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { notifyNewMessage } from '@/lib/notification';

export async function POST(req: NextRequest) {
  try {
    const uid = await verifyToken(req);
    const { chatId, text } = await req.json();

    if (!chatId || !text?.trim()) {
      return NextResponse.json({ message: 'Missing chatId or text' }, { status: 400 });
    }

    const chatRef  = db.collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();

    if (!chatSnap.exists) {
      return NextResponse.json({ message: 'Chat not found' }, { status: 404 });
    }

    const chat    = chatSnap.data()!;
    const isHost  = chat.host_id  === uid;
    const isRider = chat.rider_id === uid;

    if (!isHost && !isRider) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 403 });
    }

    const recipientId  = isHost ? chat.rider_id : chat.host_id;
    const unreadField  = isHost ? 'unread_rider' : 'unread_host';
    const trimmedText  = text.trim();
    const now          = new Date().toISOString();

    await db.collection('chats').doc(chatId)
      .collection('messages').add({
        chat_id:    chatId,
        sender_id:  uid,
        text:       trimmedText,
        created_at: FieldValue.serverTimestamp(),
        read:       false,
      });

    await chatRef.update({
      last_message:    trimmedText,
      last_message_at: now,
      [unreadField]:   (chat[unreadField] ?? 0) + 1,
    });

    const [senderDoc, recipientDoc] = await Promise.all([
      db.collection('users').doc(uid).get(),
      db.collection('users').doc(recipientId).get(),
    ]);

    const senderName = senderDoc.data()?.name ?? 'Someone';
    const recipToken = recipientDoc.data()?.expo_push_token ?? null;

    const preview = trimmedText.length > 60
      ? trimmedText.slice(0, 57) + '…'
      : trimmedText;

    await notifyNewMessage(recipientId, recipToken, senderName, preview, chatId);

    return NextResponse.json({ sent: true });

  } catch (err: any) {
    console.error('[send-message]', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}