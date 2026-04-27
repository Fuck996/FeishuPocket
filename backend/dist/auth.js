import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
export function hashPassword(password) {
    return bcrypt.hash(password, 10);
}
export function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export function signToken(secret, user) {
    const payload = {
        userId: user.id,
        role: user.role
    };
    return jwt.sign(payload, secret, { expiresIn: '7d' });
}
export function verifyToken(secret, token) {
    return jwt.verify(token, secret);
}
