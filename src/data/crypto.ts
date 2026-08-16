import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

// Field-level at-rest encryption for sensitive free text (PRD §21.5).
// Format: mlx1.<base64url iv>.<base64url auth tag>.<base64url ciphertext>.
// Searchable metadata (titles, triggers, statuses, scopes) stays plaintext by
// design; encrypted bodies are decrypted in memory for scoped relevance scans.

const FIELD_PREFIX = 'mlx1';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

export interface DataKeyProvider {
  getKey(): Buffer;
}

export class StaticDataKeyProvider implements DataKeyProvider {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_LENGTH) throw new Error('Data key must be 32 bytes.');
    this.#key = Buffer.from(key);
  }

  static random(): StaticDataKeyProvider {
    return new StaticDataKeyProvider(randomBytes(KEY_LENGTH));
  }

  getKey(): Buffer {
    return Buffer.from(this.#key);
  }
}

export function generateDataKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export class FieldCodec {
  readonly #provider: DataKeyProvider;

  constructor(provider: DataKeyProvider) {
    this.#provider = provider;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.#provider.getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      FIELD_PREFIX,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  decrypt(stored: string): string {
    const parts = stored.split('.');
    const [prefix, ivPart, tagPart, cipherPart] = parts;
    if (parts.length !== 4 || prefix !== FIELD_PREFIX
      || ivPart === undefined || tagPart === undefined || cipherPart === undefined) {
      throw new Error('Stored value is not an encrypted field.');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#provider.getKey(),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  static isEncrypted(value: string): boolean {
    return value.startsWith(`${FIELD_PREFIX}.`);
  }
}

// Password-based key derivation for encrypted export bundles (PRD §23.4).

const EXPORT_SALT_LENGTH = 16;
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface SealedBundle {
  salt: string;
  iv: string;
  tag: string;
  payload: string;
}

export function sealWithPassword(plaintext: Buffer, password: string): SealedBundle {
  if (password.length < 8) throw new Error('Export password must be at least 8 characters.');
  const salt = randomBytes(EXPORT_SALT_LENGTH);
  const key = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    payload: encrypted.toString('base64url'),
  };
}

export function openWithPassword(bundle: SealedBundle, password: string): Buffer {
  const key = scryptSync(
    password,
    Buffer.from(bundle.salt, 'base64url'),
    KEY_LENGTH,
    SCRYPT_OPTIONS,
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(bundle.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(bundle.payload, 'base64url')),
    decipher.final(),
  ]);
}

export function keysEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
