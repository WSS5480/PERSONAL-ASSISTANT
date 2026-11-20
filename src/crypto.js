// Password hashing (scrypt), secret encryption (AES-256-GCM), and HMAC signing.
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltB64, hashB64] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

export function createSecrets(sessionSecret) {
  const encKey = Buffer.from(crypto.hkdfSync('sha256', sessionSecret, 'my-assistant', 'secrets-aes-256-gcm-v1', 32));
  const signKey = Buffer.from(crypto.hkdfSync('sha256', sessionSecret, 'my-assistant', 'cookie-hmac-v1', 32));
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
      const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
    },
    decrypt(blob) {
      if (!blob) return null;
      const [v, iv, tag, data] = blob.split(':');
      if (v !== 'v1') throw new Error('Unknown secret format');
      const d = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    },
    sign(value) {
      return `${value}.${crypto.createHmac('sha256', signKey).update(value).digest('base64url')}`;
    },
    unsign(signed) {
      const i = String(signed || '').lastIndexOf('.');
      if (i < 1) return null;
      const value = signed.slice(0, i);
      const a = Buffer.from(signed.slice(i + 1));
      const b = Buffer.from(crypto.createHmac('sha256', signKey).update(value).digest('base64url'));
      return a.length === b.length && crypto.timingSafeEqual(a, b) ? value : null;
    },
  };
}

export const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const last4 = (s) => String(s || '').slice(-4);
