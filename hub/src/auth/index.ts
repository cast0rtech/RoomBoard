import {
  ConfidentialClientApplication,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type ClientCredentialRequest,
  type DeviceCodeRequest,
  type SilentFlowRequest,
} from '@azure/msal-node';
import { loadConfig, type HubConfig } from '../config.js';
import {
  AuthConfigurationError,
  withRetry,
  type RetryOptions,
} from './retry.js';
import {
  createEncryptedPersistenceCachePlugin,
  type EncryptedCacheOptions,
} from './tokenCache.js';

export {
  AuthConfigurationError,
  AuthTokenError,
  withRetry,
  type RetryOptions,
} from './retry.js';
export {
  createEncryptedPersistenceCachePlugin,
  decryptCachePayload,
  encryptCachePayload,
  getDefaultCacheFilePath,
  type EncryptedCacheOptions,
} from './tokenCache.js';

/** Scopes de privilegio mínimo en modo delegado (solo lectura + refresco) */
export const DELEGATED_SCOPES: readonly string[] = [
  'Calendars.Read',
  'Calendars.Read.Shared',
  'offline_access',
  'User.Read',
];

/** Scope estándar para client credentials en Microsoft Graph */
export const APP_SCOPES: readonly string[] = ['https://graph.microsoft.com/.default'];

export interface AuthTokenProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
}

export interface AuthLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TokenCacheLike {
  getAllAccounts(): Promise<AccountInfo[]>;
}

export interface PublicClientLike {
  getTokenCache(): TokenCacheLike;
  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult | null>;
  acquireTokenByDeviceCode(request: DeviceCodeRequest): Promise<AuthenticationResult | null>;
}

export interface ConfidentialClientLike {
  acquireTokenByClientCredential(
    request: ClientCredentialRequest,
  ): Promise<AuthenticationResult | null>;
}

export interface AuthProviderOptions {
  cacheOptions?: EncryptedCacheOptions;
  retryOptions?: RetryOptions;
  logger?: AuthLogger;
  publicClientFactory?: (config: HubConfig) => PublicClientLike;
  confidentialClientFactory?: (config: HubConfig) => ConfidentialClientLike;
}

const defaultLogger: AuthLogger = {
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

function buildAuthorityUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId.trim()}`;
}

function validateAuthConfig(config: HubConfig): void {
  if (!config.TENANT_ID || config.TENANT_ID === 'unconfigured-tenant-id') {
    throw new AuthConfigurationError('TENANT_ID es obligatorio para autenticar con Microsoft Graph.');
  }
  if (!config.CLIENT_ID || config.CLIENT_ID === 'unconfigured-client-id') {
    throw new AuthConfigurationError('CLIENT_ID es obligatorio para autenticar con Microsoft Graph.');
  }
  if (config.AUTH_MODE === 'app' && (!config.CLIENT_SECRET || !config.CLIENT_SECRET.trim())) {
    throw new AuthConfigurationError(
      'CLIENT_SECRET es obligatorio cuando AUTH_MODE está configurado como "app".',
    );
  }
}

function createDefaultPublicClient(
  config: HubConfig,
  cacheOptions?: EncryptedCacheOptions,
): PublicClientLike {
  const cachePlugin = createEncryptedPersistenceCachePlugin(cacheOptions);
  return new PublicClientApplication({
    auth: {
      clientId: config.CLIENT_ID,
      authority: buildAuthorityUrl(config.TENANT_ID),
    },
    cache: {
      cachePlugin,
    },
  });
}

function createDefaultConfidentialClient(
  config: HubConfig,
  cacheOptions?: EncryptedCacheOptions,
): ConfidentialClientLike {
  const cachePlugin = createEncryptedPersistenceCachePlugin(cacheOptions);
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.CLIENT_ID,
      authority: buildAuthorityUrl(config.TENANT_ID),
      clientSecret: config.CLIENT_SECRET ?? '',
    },
    cache: {
      cachePlugin,
    },
  });
}

function extractAccessToken(result: AuthenticationResult | null): string {
  if (!result || !result.accessToken) {
    throw new Error('MSAL devolvió un resultado vacío o sin accessToken.');
  }
  return result.accessToken;
}

/**
 * Crea un proveedor de tokens MSAL para modo "delegated" (Device Code + renovación silenciosa)
 * o modo "app" (Client Credentials).
 */
export function createAuthProvider(
  config: HubConfig,
  options: AuthProviderOptions = {},
): AuthTokenProvider {
  validateAuthConfig(config);

  const logger = options.logger ?? defaultLogger;
  const retryOptions: RetryOptions = {
    maxAttempts: options.retryOptions?.maxAttempts ?? 3,
    baseDelayMs: options.retryOptions?.baseDelayMs ?? 300,
    onRetry: (attempt, error) => {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`[Auth] Reintentando obtención de token (intento ${attempt}): ${detail}`);
      options.retryOptions?.onRetry?.(attempt, error);
    },
  };

  let inFlightPromise: Promise<string> | null = null;
  let publicClient: PublicClientLike | null = null;
  let confidentialClient: ConfidentialClientLike | null = null;

  async function acquireDelegatedToken(forceRefresh = false): Promise<string> {
    if (!publicClient) {
      publicClient = options.publicClientFactory
        ? options.publicClientFactory(config)
        : createDefaultPublicClient(config, options.cacheOptions);
    }

    const client = publicClient;
    const accounts = await client.getTokenCache().getAllAccounts();
    const primaryAccount = accounts[0];

    if (primaryAccount) {
      try {
        const silentResult = await withRetry(
          () =>
            client.acquireTokenSilent({
              account: primaryAccount,
              scopes: [...DELEGATED_SCOPES],
              ...(forceRefresh ? { forceRefresh: true } : {}),
            }),
          retryOptions,
        );
        return extractAccessToken(silentResult);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[Auth] No se pudo renovar el token en silencio (${detail}). Iniciando flujo de código de dispositivo...`,
        );
      }
    }

    const deviceCodeResult = await withRetry(
      () =>
        client.acquireTokenByDeviceCode({
          scopes: [...DELEGATED_SCOPES],
          deviceCodeCallback: (response) => {
            logger.info(
              `[Auth] Inicia sesión en ${response.verificationUri} e introduce el código: ${response.userCode}`,
            );
            if (response.message) {
              logger.info(response.message);
            }
          },
        }),
      retryOptions,
    );

    return extractAccessToken(deviceCodeResult);
  }

  async function acquireAppToken(forceRefresh = false): Promise<string> {
    if (!confidentialClient) {
      confidentialClient = options.confidentialClientFactory
        ? options.confidentialClientFactory(config)
        : createDefaultConfidentialClient(config, options.cacheOptions);
    }

    const client = confidentialClient;
    const result = await withRetry(
      () =>
        client.acquireTokenByClientCredential({
          scopes: [...APP_SCOPES],
          ...(forceRefresh ? { skipCache: true } : {}),
        }),
      retryOptions,
    );

    return extractAccessToken(result);
  }

  return {
    async getAccessToken(forceRefresh = false): Promise<string> {
      if (inFlightPromise && !forceRefresh) {
        return inFlightPromise;
      }

      const task =
        config.AUTH_MODE === 'app'
          ? acquireAppToken(forceRefresh)
          : acquireDelegatedToken(forceRefresh);

      inFlightPromise = task.finally(() => {
        inFlightPromise = null;
      });

      return inFlightPromise;
    },
  };
}

let defaultProvider: AuthTokenProvider | null = null;

/**
 * Reinicia el proveedor de autenticación por defecto (útil en tests o recarga de configuración).
 */
export function resetDefaultAuthProvider(): void {
  defaultProvider = null;
}

/**
 * Función común para obtener un token de acceso válido para Microsoft Graph
 * según el modo configurado en `AUTH_MODE` ("delegated" o "app").
 */
export async function getAccessToken(
  config?: HubConfig,
  options?: AuthProviderOptions,
): Promise<string> {
  if (config || options) {
    const provider = createAuthProvider(config ?? loadConfig(), options);
    return provider.getAccessToken();
  }

  if (!defaultProvider) {
    defaultProvider = createAuthProvider(loadConfig());
  }

  return defaultProvider.getAccessToken();
}
