import { NextRequest } from 'next/server';
import { auth } from './firebase-admin';

export async function verifyToken(req: NextRequest): Promise<string> {
  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token   = authHeader.split('Bearer ')[1];
  const decoded = await auth.verifyIdToken(token);
  return decoded.uid;
}