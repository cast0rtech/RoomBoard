import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AccountInfo,
  AuthenticationResult,
  DeviceCodeRequest,
  TokenCacheContext,
} from '@azure/msal-node';
import { describe, expect, it, vi } from 'vitest';
import type { HubConfig } from '../config.js';
import {
  APP_SCOPES,
  AuthConfigurationError,
  AuthTokenError,
  createEncryptedPersistenceCachePlugin,
  DELEGATED_SCOPES,
  getAccessToken,
  type AuthLogger,
  type ConfidentialClientLike,
  type PublicClientLike,
} from './index.js';

function createBaseConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    AUTH_MODE: 'delegated',
    TENANT_ID: '11111111-2222-3333-4444-555555555555',
    CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    CLIENT_SECRET: undefined,
    ROOM_MAILBOXES: 'sala1@empresa.com',
    TIMEZONE: 'Europe/Madrid',
    PORT: 8080,
    DEVICE_KEYS: 'clave-test',
    POLL_SECONDS: 45,
    IGNORE_ALL_DAY: true,
    IGNORE_ALL_DAY_EVENTS: true,
    ...overrides,
  };
}

function createFakeAccount(): AccountInfo {
  return {
    homeAccountId: 'home-account-id',
    environment: 'login.microsoftonline.com',
    tenantId: '11111111-2222-3333-4444-555555555555',
    username: 'usuario@empresa.com',
    localAccountId: 'local-account-id',
  };
}

function createFakeAuthResult(accessToken: string): AuthenticationResult {
  return {
    authority: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555',
    uniqueId: 'unique-id',
    tenantId: '11111111-2222-3333-4444-555555555555',
    scopes: [...DELEGATED_SCOPES],
    account: createFakeAccount(),
    idToken: 'fake-id-token',
    idTokenClaims: {},
    accessToken,
    fromCache: false,
    expiresOn: new Date(Date.now() + 3600_000),
    tokenType: 'Bearer',
    correlationId: 'corr-id',
  };
}

function createTestLogger(): AuthLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (msg: string) => messages.push(`INFO: ${msg}`),
    warn: (msg: string) => messages.push(`WARN: ${msg}`),
    error: (msg: string) => messages.push(`ERROR: ${msg}`),
  };
}

describe('Módulo de autenticación (hub/src/auth)', () => {
  it('en modo delegated usa flujo de código de dispositivo cuando no hay cuenta en caché y muestra URL y código', async () => {
    const logger = createTestLogger();
    const acquireTokenSilent = vi.fn();
    const acquireTokenByDeviceCode = vi.fn(async (request: DeviceCodeRequest) => {
      request.deviceCodeCallback({
        userCode: 'ABCD-1234',
        deviceCode: 'device-code-xyz',
        verificationUri: 'https://microsoft.com/devicelogin',
        expiresIn: 900,
        interval: 5,
        message: 'Para iniciar sesión, abre https://microsoft.com/devicelogin e introduce ABCD-1234',
      });
      return createFakeAuthResult('token-delegado-device-code');
    });

    const fakePublicClient: PublicClientLike = {
      getTokenCache: () => ({
        getAllAccounts: async () => [],
      }),
      acquireTokenSilent,
      acquireTokenByDeviceCode,
    };

    const token = await getAccessToken(createBaseConfig({ AUTH_MODE: 'delegated' }), {
      logger,
      publicClientFactory: () => fakePublicClient,
      retryOptions: { maxAttempts: 2, baseDelayMs: 0 },
    });

    expect(token).toBe('token-delegado-device-code');
    expect(acquireTokenSilent).not.toHaveBeenCalled();
    expect(acquireTokenByDeviceCode).toHaveBeenCalledTimes(1);
    expect(acquireTokenByDeviceCode.mock.calls[0]?.[0]?.scopes).toEqual([...DELEGATED_SCOPES]);
    expect(
      logger.messages.some(
        (msg) =>
          msg.includes('https://microsoft.com/devicelogin') && msg.includes('ABCD-1234'),
      ),
    ).toBe(true);
  });

  it('en modo delegated renueva el token en silencio si existe una cuenta en caché', async () => {
    const logger = createTestLogger();
    const cachedAccount = createFakeAccount();
    const acquireTokenSilent = vi
      .fn()
      .mockResolvedValue(createFakeAuthResult('token-delegado-silencioso'));
    const acquireTokenByDeviceCode = vi.fn();

    const fakePublicClient: PublicClientLike = {
      getTokenCache: () => ({
        getAllAccounts: async () => [cachedAccount],
      }),
      acquireTokenSilent,
      acquireTokenByDeviceCode,
    };

    const token = await getAccessToken(createBaseConfig({ AUTH_MODE: 'delegated' }), {
      logger,
      publicClientFactory: () => fakePublicClient,
      retryOptions: { maxAttempts: 1, baseDelayMs: 0 },
    });

    expect(token).toBe('token-delegado-silencioso');
    expect(acquireTokenSilent).toHaveBeenCalledWith({
      account: cachedAccount,
      scopes: [...DELEGATED_SCOPES],
    });
    expect(acquireTokenByDeviceCode).not.toHaveBeenCalled();
  });

  it('en modo delegated recurre a código de dispositivo si falla acquireTokenSilent', async () => {
    const logger = createTestLogger();
    const cachedAccount = createFakeAccount();
    const acquireTokenSilent = vi
      .fn()
      .mockRejectedValue(new Error('InteractionRequiredAuthError'));
    const acquireTokenByDeviceCode = vi
      .fn()
      .mockResolvedValue(createFakeAuthResult('token-recuperado-device-code'));

    const fakePublicClient: PublicClientLike = {
      getTokenCache: () => ({
        getAllAccounts: async () => [cachedAccount],
      }),
      acquireTokenSilent,
      acquireTokenByDeviceCode,
    };

    const token = await getAccessToken(createBaseConfig({ AUTH_MODE: 'delegated' }), {
      logger,
      publicClientFactory: () => fakePublicClient,
      retryOptions: { maxAttempts: 1, baseDelayMs: 0 },
    });

    expect(token).toBe('token-recuperado-device-code');
    expect(acquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(acquireTokenByDeviceCode).toHaveBeenCalledTimes(1);
  });

  it('en modo app obtiene token mediante client credentials y exige CLIENT_SECRET', async () => {
    const acquireTokenByClientCredential = vi
      .fn()
      .mockResolvedValue(createFakeAuthResult('token-modo-app'));

    const fakeConfidentialClient: ConfidentialClientLike = {
      acquireTokenByClientCredential,
    };

    const token = await getAccessToken(
      createBaseConfig({
        AUTH_MODE: 'app',
        CLIENT_SECRET: 'secreto-super-seguro',
      }),
      {
        confidentialClientFactory: () => fakeConfidentialClient,
        retryOptions: { maxAttempts: 2, baseDelayMs: 0 },
      },
    );

    expect(token).toBe('token-modo-app');
    expect(acquireTokenByClientCredential).toHaveBeenCalledWith({
      scopes: [...APP_SCOPES],
    });

    await expect(
      getAccessToken(createBaseConfig({ AUTH_MODE: 'app', CLIENT_SECRET: '' })),
    ).rejects.toThrow(AuthConfigurationError);
  });

  it('reintenta ante fallos transitorios de MSAL y lanza AuthTokenError si se agotan los intentos', async () => {
    const logger = createTestLogger();
    let attempts = 0;

    const flakyConfidentialClient: ConfidentialClientLike = {
      acquireTokenByClientCredential: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('Error de red temporal en Entra ID');
        }
        return createFakeAuthResult('token-tras-reintento');
      }),
    };

    const token = await getAccessToken(
      createBaseConfig({ AUTH_MODE: 'app', CLIENT_SECRET: 'secreto' }),
      {
        logger,
        confidentialClientFactory: () => flakyConfidentialClient,
        retryOptions: { maxAttempts: 3, baseDelayMs: 0 },
      },
    );

    expect(token).toBe('token-tras-reintento');
    expect(attempts).toBe(3);

    const alwaysFailingClient: ConfidentialClientLike = {
      acquireTokenByClientCredential: vi
        .fn()
        .mockRejectedValue(new Error('Servicio no disponible')),
    };

    await expect(
      getAccessToken(createBaseConfig({ AUTH_MODE: 'app', CLIENT_SECRET: 'secreto' }), {
        logger,
        confidentialClientFactory: () => alwaysFailingClient,
        retryOptions: { maxAttempts: 2, baseDelayMs: 0 },
      }),
    ).rejects.toThrow(AuthTokenError);
  });

  it('guarda y restaura la caché de tokens cifrada en disco local', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'roomboard-auth-test-'));
    const cacheFilePath = path.join(tempDir, 'msal-cache.enc');

    try {
      const plugin = createEncryptedPersistenceCachePlugin({
        cacheFilePath,
        secretMaterial: 'clave-test-local',
      });

      const sampleJson = JSON.stringify({
        Account: { 'acc-1': { username: 'sala1@empresa.com' } },
        RefreshToken: { 'rt-1': { secret: 'refresh-token-ultrasecreto' } },
      });

      const writeContext = {
        cacheHasChanged: true,
        tokenCache: {
          serialize: () => sampleJson,
          deserialize: vi.fn(),
        },
      } as unknown as TokenCacheContext;

      await plugin.afterCacheAccess(writeContext);

      const rawBytes = await readFile(cacheFilePath);
      expect(rawBytes.toString('utf8')).not.toContain('refresh-token-ultrasecreto');

      let restoredJson = '';
      const readContext = {
        cacheHasChanged: false,
        tokenCache: {
          serialize: () => '',
          deserialize: (data: string) => {
            restoredJson = data;
          },
        },
      } as unknown as TokenCacheContext;

      await plugin.beforeCacheAccess(readContext);
      expect(restoredJson).toBe(sampleJson);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

