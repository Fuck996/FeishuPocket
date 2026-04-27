import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { UserAccount } from './types.js';

export interface AuthTokenPayload {
  userId: string;
  role: 'admin' | 'operator';
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(secret: string, user: UserAccount): string {
  const payload: AuthTokenPayload = {
    userId: user.id,
    role: user.role
  };
  return jwt.sign(payload, secret, { expiresIn: '7d' });
}

export function verifyToken(secret: string, token: string): AuthTokenPayload {
  return jwt.verify(token, secret) as AuthTokenPayload;
}
