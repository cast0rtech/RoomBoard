import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export interface EncryptedCacheOptions {
  /** Ruta del archivo cifrado. Por defecto: ~/.roomboard/msal-cache.enc (fuera del repositorio) */
  cacheFilePath?: string;
  /** Secreto opcional para derivar la clave de cifrado local */
  secretMaterial?: string;
}

/**
 * Devuelve la ruta por defecto fuera del repositorio donde se almacena la caché cifrada.
 */
export function getDefaultCacheFilePath(): string {
  return path.join(os.homedir(), '.roomboard', 'msal-token-cache.enc');
}

function getDefaultSecretMaterial(): string {
  const userInfo = os.userInfo();
  return `roomboard:${os.hostname()}:${userInfo.username}:${os.homedir()}`;
}

/**
 * Cifra un texto en claro usando AES-256-GCM y devuelve un Buffer con formato:
 * [salt (16B)][iv (12B)][authTag (16B)][ciphertext]
 */
export function encryptCachePayload(plaintext: string, secretMaterial: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = scryptSync(secretMaterial, salt, KEY_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Descifra un Buffer producido por `encryptCachePayload`.
 */
export function decryptCachePayload(payload: Buffer, secretMaterial: string): string {
  const minLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (payload.length < minLength) {
    throw new Error('El archivo de caché cifrada tiene un tamaño inválido.');
  }

  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = payload.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = scryptSync(secretMaterial, salt, KEY_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Crea un plugin de caché para MSAL Node que persiste los tokens cifrados en disco local.
 */
export function createEncryptedPersistenceCachePlugin(
  options: EncryptedCacheOptions = {},
): ICachePlugin {
  const cacheFilePath = options.cacheFilePath ?? getDefaultCacheFilePath();
  const secretMaterial = options.secretMaterial ?? getDefaultSecretMaterial();

  return {
    async beforeCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
      try {
        const encryptedBytes = await readFile(cacheFilePath);
        const serialized = decryptCachePayload(encryptedBytes, secretMaterial);
        cacheContext.tokenCache.deserialize(serialized);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return;
        }
        // Si el archivo está corrupto o cambió la clave, ignoramos la caché previa para permitir reautenticar
      }
    },

    async afterCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
      if (!cacheContext.cacheHasChanged) {
        return;
      }

      const serialized = cacheContext.tokenCache.serialize();
      const encryptedBytes = encryptCachePayload(serialized, secretMaterial);
      const directory = path.dirname(cacheFilePath);

      await mkdir(directory, { recursive: true, mode: 0o700 });
      const tempFilePath = `${cacheFilePath}.tmp-${process.pid}`;
      await writeFile(tempFilePath, encryptedBytes, { mode: 0o600 });
      await rename(tempFilePath, cacheFilePath);
    },
  };
}

