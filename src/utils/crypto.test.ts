import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createCrypto } from './crypto';

const key = randomBytes(32).toString('base64');

test('round trip', () => {
  const { encrypt, decrypt } = createCrypto(key);
  const secret = 'refresh-token-🔑';
  const encrypted = encrypt(secret);

  expect(encrypted).not.toContain(secret);
  expect(encrypt(secret)).not.toBe(encrypted);
  expect(decrypt(encrypted)).toBe(secret);
});

test('tampering is detected', () => {
  const { encrypt, decrypt } = createCrypto(key);
  const [iv, tag] = encrypt('value').split('.');
  const forged = [iv, tag, Buffer.from('other').toString('base64')].join('.');

  expect(() => decrypt(forged)).toThrow();
});

test('rejects keys that are not 32 bytes', () => {
  expect(() => createCrypto(randomBytes(16).toString('base64'))).toThrow();
});
