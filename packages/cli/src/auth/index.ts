import { createHash } from 'node:crypto';
import { CliError } from '../core/errors.js';
import {
  StudioClient,
  invalidResponse,
  object,
  string,
  type ObjectValue,
} from './client.js';
import { browserLogin, type LoginOptions } from './login.js';
import { AuthStorage, type Profile, type State } from './storage.js';

export interface AuthOptions {
  studioOrigin: string;
  studioWebOrigin?: string;
  consoleOrigin: string;
  mediaOrigin: string;
  configDir?: string;
  fetch?: typeof globalThis.fetch;
}

export interface AppSummary {
  appId: string;
  name: string;
  createdAt: string;
}
interface App extends AppSummary {
  keys: Array<{ value: string; createdAt: string }>;
}
export interface AuthStatus {
  authenticated: boolean;
  userId?: string;
  profileKey?: string;
  appId?: string;
  expiresAt?: string;
}

const defaultAppName = 'Spatius CLI';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function canonicalOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw new CliError(
      'INVALID_CONFIG',
      'Studio and Console origins must be HTTPS origins, or HTTP loopback origins for local development.',
    );
  }
  return url.origin;
}

function requireLogin(): CliError {
  return new CliError(
    'AUTH_REQUIRED',
    'Log in to Spatius Studio before using this command.',
    { recovery: 'Run spatius auth login.', exitCode: 1 },
  );
}

function relogin(): CliError {
  return new CliError(
    'AUTH_RELOGIN_REQUIRED',
    'The previous token refresh did not complete safely.',
    {
      recovery:
        'Run spatius auth login. Do not retry the previous refresh token.',
      exitCode: 1,
    },
  );
}

function safeApp(app: App): AppSummary {
  return { appId: app.appId, name: app.name, createdAt: app.createdAt };
}

function parseApp(raw: unknown): App {
  const value = object(raw);
  const keys = value.apiKeys === undefined ? [] : value.apiKeys;
  if (!Array.isArray(keys)) throw invalidResponse();
  return {
    appId: string(value, 'appId'),
    name: string(value, 'name'),
    createdAt: string(value, 'createdAt'),
    keys: keys.map((raw) => {
      const key = object(raw);
      return {
        value: string(key, 'apiKey'),
        createdAt: string(key, 'createdAt'),
      };
    }),
  };
}

function applyTokens(profile: Profile, value: unknown): void {
  const token = object(value);
  const access = string(token, 'accessToken');
  const refresh = string(token, 'refreshToken');
  let expiry =
    typeof token.expiresAt === 'string' ? Date.parse(token.expiresAt) : NaN;
  if (
    !Number.isFinite(expiry) &&
    typeof token.expiresIn === 'number' &&
    token.expiresIn > 0
  )
    expiry = Date.now() + token.expiresIn * 1000;
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw invalidResponse();
  profile.accessToken = access;
  profile.refreshToken = refresh;
  profile.expiresAt = new Date(expiry).toISOString();
  delete profile.refreshPending;
}

export class AuthManager {
  private readonly studioOrigin: string;
  private readonly studioWebOrigin: string;
  private readonly consoleOrigin: string;
  private readonly originKey: string;
  private readonly storage: AuthStorage;
  private readonly client: StudioClient;

  constructor(options: AuthOptions) {
    this.studioOrigin = canonicalOrigin(options.studioOrigin);
    this.studioWebOrigin = canonicalOrigin(
      options.studioWebOrigin ?? 'https://app.spatius.ai',
    );
    this.consoleOrigin = canonicalOrigin(options.consoleOrigin);
    this.originKey = hash(`${this.studioOrigin}\n${this.consoleOrigin}`);
    this.storage = new AuthStorage(options.configDir);
    this.client = new StudioClient(this.studioOrigin, options.fetch);
  }

  stateDirectory(): string {
    return this.storage.directory;
  }

  async login(options: LoginOptions = {}): Promise<AuthStatus> {
    const result = await browserLogin(
      this.client,
      this.studioWebOrigin,
      options,
    );
    const userId = string(object(result.user), 'id');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        userId,
      )
    )
      throw invalidResponse();
    return this.storage.locked(async (state) => {
      const profileKey = this.profileKey(userId);
      const profile: Profile = state.profiles[profileKey] ?? {
        userId,
        consoleOrigin: this.consoleOrigin,
        studioOrigin: this.studioOrigin,
      };
      applyTokens(profile, result.token);
      state.profiles[profileKey] = profile;
      state.active[this.originKey] = profileKey;
      await this.storage.write(state);
      return this.summary(profile);
    });
  }

  async status(): Promise<AuthStatus> {
    return this.storage.locked(async (state) => {
      const profile = this.current(state, false);
      if (
        !profile?.accessToken ||
        !profile.refreshToken ||
        profile.refreshPending
      )
        return { authenticated: false };
      try {
        await this.verifyIdentity(state, profile);
        return this.summary(profile);
      } catch (error) {
        if (
          error instanceof CliError &&
          (error.options.status === 401 ||
            error.code === 'AUTH_RELOGIN_REQUIRED' ||
            error.code === 'AUTH_REQUIRED')
        )
          return { authenticated: false };
        throw error;
      }
    });
  }

  async logout(): Promise<{ authenticated: false; revoked: boolean }> {
    return this.storage.locked(async (state) => {
      const profile = this.current(state, false);
      if (!profile) return { authenticated: false, revoked: true };
      let revoked = true;
      try {
        if (profile.refreshToken)
          await this.client.request('/v1/cli/auth/token:revoke', {
            body: { refreshToken: profile.refreshToken },
          });
      } catch {
        revoked = false;
      }
      delete profile.accessToken;
      delete profile.refreshToken;
      delete profile.expiresAt;
      delete profile.refreshPending;
      delete profile.apiKey;
      await this.storage.write(state);
      return { authenticated: false, revoked };
    });
  }

  async accessToken(): Promise<string> {
    return this.storage.locked(async (state) => {
      const profile = this.current(state);
      await this.ensureToken(state, profile);
      return profile.accessToken!;
    });
  }

  async identity(): Promise<{ userId: string; profileKey: string }> {
    return this.storage.locked(async (state) => {
      const profile = this.current(state);
      await this.verifyIdentity(state, profile);
      return {
        userId: profile.userId,
        profileKey: this.profileKey(profile.userId),
      };
    });
  }

  async credentials(): Promise<{
    appId: string;
    apiKey: string;
    userId: string;
  }> {
    return this.storage.locked(async (state) => {
      const profile = this.current(state);
      await this.verifyIdentity(state, profile);
      if (!profile.appId || !profile.apiKey)
        throw new CliError(
          'SETUP_REQUIRED',
          'No app credentials are configured for this Studio account.',
          { recovery: 'Run spatius setup.' },
        );
      const app = await this.getApp(state, profile, profile.appId);
      if (!app.keys.some((key) => key.value === profile.apiKey)) {
        delete profile.apiKey;
        await this.storage.write(state);
        throw new CliError(
          'APP_KEY_UNAVAILABLE',
          'The selected app key is no longer active.',
          { recovery: 'Run spatius setup to select an active key.' },
        );
      }
      return {
        userId: profile.userId,
        appId: profile.appId,
        apiKey: profile.apiKey,
      };
    });
  }

  async listApps(): Promise<AppSummary[]> {
    return this.storage.locked(async (state) => {
      const profile = this.current(state);
      await this.verifyIdentity(state, profile);
      return (await this.apps(state, profile)).map(safeApp);
    });
  }

  async setup(
    options: { appId?: string; retryUncertain?: boolean } = {},
  ): Promise<{ appId: string; userId: string; reused: boolean }> {
    return this.storage.locked(async (state) => {
      const profile = this.current(state);
      await this.verifyIdentity(state, profile);
      let app: App | undefined;
      let reused = true;
      if (options.appId !== undefined) {
        if (!options.appId.trim())
          throw new CliError('INVALID_ARGUMENT', 'An app ID is required.');
        app = await this.getApp(state, profile, options.appId);
        if (profile.appId !== app.appId) {
          delete profile.apiKey;
          delete profile.pendingKey;
        }
        profile.appId = app.appId;
        delete profile.pendingApp;
        await this.storage.write(state);
      } else {
        if (profile.appId) {
          try {
            app = await this.getApp(state, profile, profile.appId);
          } catch (error) {
            if (
              !(error instanceof CliError) ||
              error.code !== 'APP_UNAVAILABLE'
            )
              throw error;
            delete profile.appId;
            delete profile.apiKey;
            delete profile.pendingKey;
            await this.storage.write(state);
          }
        }
        if (!app) {
          app = this.matchApp(await this.apps(state, profile));
          if (!app) {
            if (profile.pendingApp && !options.retryUncertain)
              throw this.uncertain('app');
            profile.pendingApp = true;
            await this.storage.write(state);
            try {
              const created = await this.authorized(state, profile, (token) =>
                this.client.request('/v1/apps', {
                  token,
                  body: { name: defaultAppName },
                }),
              );
              profile.appId = string(created, 'appId');
              delete profile.pendingApp;
              await this.storage.write(state);
              reused = false;
              app = await this.getApp(state, profile, profile.appId);
            } catch (error) {
              if (profile.appId) throw error;
              if (this.definiteRejection(error)) {
                delete profile.pendingApp;
                await this.storage.write(state);
                throw error;
              }
              app = this.matchApp(await this.apps(state, profile));
              if (!app) throw this.uncertain('app');
            }
          }
          profile.appId = app.appId;
          delete profile.pendingApp;
          await this.storage.write(state);
        }
      }
      if (!app) throw invalidResponse();
      const selectKey = (candidate: App): string | undefined => {
        const cached = candidate.keys.find(
          (key) => key.value === profile.apiKey,
        );
        return (
          cached?.value ??
          [...candidate.keys].sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              hash(a.value).localeCompare(hash(b.value)),
          )[0]?.value
        );
      };
      let key = selectKey(app);
      if (!key) {
        if (profile.pendingKey && !options.retryUncertain)
          throw this.uncertain('key');
        profile.pendingKey = true;
        await this.storage.write(state);
        try {
          const response = await this.authorized(state, profile, (token) =>
            this.client.request(
              `/v1/apps/${encodeURIComponent(app.appId)}/api-keys`,
              { token, body: { appId: app.appId } },
            ),
          );
          key = string(object(response.apiKey), 'apiKey');
        } catch (error) {
          if (this.definiteRejection(error)) {
            delete profile.pendingKey;
            await this.storage.write(state);
            throw error;
          }
          key = selectKey(await this.getApp(state, profile, app.appId));
          if (!key) throw this.uncertain('key');
        }
      }
      profile.apiKey = key;
      delete profile.pendingKey;
      await this.storage.write(state);
      return { userId: profile.userId, appId: app.appId, reused };
    });
  }

  private uncertain(kind: 'app' | 'key'): CliError {
    return new CliError(
      'BOOTSTRAP_UNCERTAIN',
      `Studio may have created the ${kind}, but it is not visible yet.`,
      {
        recovery:
          'Run spatius setup again to reconcile. Only if creation did not complete, use spatius setup --retry-uncertain; it can create a duplicate.',
      },
    );
  }

  private definiteRejection(error: unknown): boolean {
    return (
      error instanceof CliError &&
      error.options.status !== undefined &&
      error.options.status >= 400 &&
      error.options.status < 500 &&
      error.options.status !== 408
    );
  }

  private profileKey(userId: string): string {
    return hash(`${this.originKey}\n${userId}`);
  }

  private current(state: State): Profile;
  private current(state: State, required: false): Profile | undefined;
  private current(state: State, required = true): Profile | undefined {
    const key = state.active[this.originKey];
    const profile = key ? state.profiles[key] : undefined;
    if (!profile) {
      if (required) throw requireLogin();
      return undefined;
    }
    if (
      profile.consoleOrigin !== this.consoleOrigin ||
      profile.studioOrigin !== this.studioOrigin ||
      this.profileKey(profile.userId) !== key
    )
      throw new CliError(
        'AUTH_STATE_INVALID',
        'The saved login profile does not match this environment.',
      );
    if (required && profile.refreshPending) throw relogin();
    if (required && (!profile.accessToken || !profile.refreshToken))
      throw requireLogin();
    return profile;
  }

  private summary(profile: Profile): AuthStatus {
    return {
      authenticated: true,
      userId: profile.userId,
      profileKey: this.profileKey(profile.userId),
      ...(profile.appId ? { appId: profile.appId } : {}),
      expiresAt: profile.expiresAt,
    };
  }

  private async refresh(state: State, profile: Profile): Promise<void> {
    if (profile.refreshPending) throw relogin();
    if (!profile.refreshToken) throw requireLogin();
    profile.refreshPending = true;
    await this.storage.write(state);
    try {
      const response = await this.client.request('/v1/cli/auth/token:refresh', {
        body: { refreshToken: profile.refreshToken },
      });
      applyTokens(profile, response.token);
      await this.storage.write(state);
    } catch {
      // Rotation can commit before a network failure; never replay the old token.
      profile.refreshPending = true;
      await this.storage.write(state);
      throw relogin();
    }
  }

  private async ensureToken(state: State, profile: Profile): Promise<void> {
    if (profile.refreshPending) throw relogin();
    if (!profile.accessToken || !profile.refreshToken) throw requireLogin();
    const expiry = Date.parse(profile.expiresAt ?? '');
    if (!Number.isFinite(expiry) || expiry <= Date.now() + 60_000)
      await this.refresh(state, profile);
  }

  private async authorized<T>(
    state: State,
    profile: Profile,
    operation: (token: string) => Promise<T>,
  ): Promise<T> {
    await this.ensureToken(state, profile);
    try {
      return await operation(profile.accessToken!);
    } catch (error) {
      if (!(error instanceof CliError) || error.options.status !== 401)
        throw error;
      await this.refresh(state, profile);
      return operation(profile.accessToken!);
    }
  }

  private async verifyIdentity(state: State, profile: Profile): Promise<void> {
    let response: ObjectValue;
    try {
      response = await this.authorized(state, profile, (token) =>
        this.client.request('/v1/auth/me', { token }),
      );
    } catch (error) {
      if (error instanceof CliError && error.options.status === 404)
        throw requireLogin();
      throw error;
    }
    if (string(object(response.user), 'id') !== profile.userId)
      throw new CliError(
        'AUTH_IDENTITY_MISMATCH',
        'Studio returned a different account for the saved login.',
        { recovery: 'Run spatius auth logout, then spatius auth login.' },
      );
  }

  private async getApp(
    state: State,
    profile: Profile,
    appId: string,
  ): Promise<App> {
    try {
      const response = await this.authorized(state, profile, (token) =>
        this.client.request(`/v1/apps/${encodeURIComponent(appId)}`, { token }),
      );
      const app = parseApp(response.app);
      if (app.appId !== appId) throw invalidResponse();
      return app;
    } catch (error) {
      if (error instanceof CliError && error.options.status === 404)
        throw new CliError(
          'APP_UNAVAILABLE',
          'The selected app does not exist or does not belong to this Studio account.',
          {
            recovery:
              'Run spatius apps list, then spatius setup --app-id <APP_ID>.',
          },
        );
      throw error;
    }
  }

  private async apps(state: State, profile: Profile): Promise<App[]> {
    const result = new Map<string, App>();
    const seen = new Set<string>();
    let pageToken = '';
    do {
      const query = new URLSearchParams({ 'pagination.pageSize': '100' });
      if (pageToken) query.set('pagination.pageToken', pageToken);
      const response: ObjectValue = await this.authorized(
        state,
        profile,
        (token) => this.client.request(`/v1/apps?${query}`, { token }),
      );
      const apps = response.apps === undefined ? [] : response.apps;
      if (!Array.isArray(apps)) throw invalidResponse();
      for (const raw of apps) {
        const app = parseApp(raw);
        result.set(app.appId, app);
      }
      const pagination =
        response.pagination === undefined ? {} : object(response.pagination);
      if (
        pagination.nextPageToken !== undefined &&
        typeof pagination.nextPageToken !== 'string'
      )
        throw invalidResponse();
      pageToken = (pagination.nextPageToken as string) ?? '';
      if (pageToken && (seen.has(pageToken) || seen.size >= 1000))
        throw invalidResponse();
      seen.add(pageToken);
    } while (pageToken);
    return [...result.values()];
  }

  private matchApp(apps: App[]): App | undefined {
    const matches = apps
      .filter((app) => app.name === defaultAppName)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.appId.localeCompare(b.appId),
      );
    if (matches.length > 1)
      throw new CliError(
        'APP_SELECTION_REQUIRED',
        'More than one Spatius CLI app exists for this account.',
        {
          details: { apps: matches.map(safeApp) },
          recovery:
            'Choose an app explicitly with spatius setup --app-id <APP_ID>.',
        },
      );
    return matches[0];
  }
}
