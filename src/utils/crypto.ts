import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function createCrypto(key: string) {
  const encoding = 'base64';
  const algorithm = 'aes-256-gcm';
  const _key = Buffer.from(key, encoding);

  if (_key.length !== 32) {
    throw new Error(
      '[Crypto] Encryption key must be 32 bytes, base64 encoded (openssl rand -base64 32)',
    );
  }

  function encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(algorithm, _key, iv);

    const encrypted = Buffer.concat([
      cipher.update(value, 'utf-8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return [
      iv.toString(encoding),
      tag.toString(encoding),
      encrypted.toString(encoding),
    ].join('.');
  }

  function decrypt(value: string): string {
    const [iv64, tag64, encrypted64] = value.split('.');

    if (!iv64 || !tag64 || encrypted64 === undefined) {
      throw new Error('[Crypto] Invalid encrypted value');
    }

    const iv = Buffer.from(iv64, encoding);
    const tag = Buffer.from(tag64, encoding);
    const encrypted = Buffer.from(encrypted64, encoding);

    const decipher = createDecipheriv(algorithm, _key, iv);

    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf-8');
  }

  return { encrypt, decrypt };
}

export type Crypto = ReturnType<typeof createCrypto>;
