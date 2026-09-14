import { createHash, randomUUID } from 'node:crypto';
import type { AuthManager, StudioSession } from '../auth/index.js';
import {
  invalidResponse,
  object,
  string,
  type ObjectValue,
} from '../auth/client.js';
import { CliError } from '../core/errors.js';
import { identifier, StateStore } from './state.js';

interface Pages {
  pageSize?: number;
  pageToken?: string;
}
interface CreationOptions {
  name?: string;
  appId?: string;
  resume?: string;
  showSecrets?: boolean;
}
interface Journal {
  version: 1;
  type: 'studio-app' | 'studio-key';
  id: string;
  input: { name: string } | { appId: string };
  state: 'submitting' | 'accepted' | 'rejected';
  result?: ObjectValue;
}

export const keyId = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function argument(message: string): never {
  throw new CliError('INVALID_ARGUMENT', message, { exitCode: 2 });
}

function appId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value))
    argument('Supply a valid Studio app ID.');
  return value;
}

function query(options: Pages): URLSearchParams {
  const size = options.pageSize ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 100)
    argument('--page-size must be an integer from 1 to 100.');
  const result = new URLSearchParams({ 'pagination.pageSize': String(size) });
  if (options.pageToken !== undefined)
    result.set('pagination.pageToken', options.pageToken);
  return result;
}

function page(response: ObjectValue, field: string) {
  const items = response[field] ?? [];
  if (!Array.isArray(items)) throw invalidResponse();
  const pagination =
    response.pagination === undefined ? {} : object(response.pagination);
  if (
    pagination.nextPageToken !== undefined &&
    typeof pagination.nextPageToken !== 'string'
  )
    throw invalidResponse();
  return {
    items: items.map(object),
    pagination: { nextPageToken: (pagination.nextPageToken as string) ?? '' },
  };
}

function safeKey(raw: unknown, reveal = false) {
  const key = object(raw);
  const value = string(key, 'apiKey');
  return {
    keyId: keyId(value),
    createdAt: string(key, 'createdAt'),
    ...(typeof key.createdBy === 'string' ? { createdBy: key.createdBy } : {}),
    ...(reveal ? { apiKey: value } : {}),
  };
}

/** Studio management plus the frontend's Console session-token flow. */
export class StudioWorkflows {
  constructor(
    private readonly auth: AuthManager,
    private readonly progress: (event: unknown) => void = () => {},
  ) {}

  async getApp(id: string) {
    appId(id);
    return this.auth.withStudioSession(async (session) => {
      const app = object(
        (await session.request(`/v1/apps/${encodeURIComponent(id)}`)).app,
      );
      if (string(app, 'appId') !== id) throw invalidResponse();
      const keys = app.apiKeys ?? [];
      if (!Array.isArray(keys)) throw invalidResponse();
      return {
        appId: id,
        name: string(app, 'name'),
        createdAt: string(app, 'createdAt'),
        apiKeyCount: keys.length,
        ...(typeof app.updatedAt === 'string'
          ? { updatedAt: app.updatedAt }
          : {}),
        ...(typeof app.createdBy === 'string'
          ? { createdBy: app.createdBy }
          : {}),
      };
    });
  }

  async deleteApp(id: string) {
    appId(id);
    return this.auth.withStudioSession(async (session) => {
      // Invalidate before submission: a lost delete response must not leave a cached credential active.
      await session.clearSelection(id);
      await this.remove(session, `/v1/apps/${encodeURIComponent(id)}`);
      return { appId: id, deleted: true };
    });
  }

  async listKeys(id: string, options: Pages & { showSecrets?: boolean } = {}) {
    appId(id);
    const params = query(options);
    return this.auth.withStudioSession(async (session) => {
      const result = page(
        await session.request(
          `/v1/apps/${encodeURIComponent(id)}/api-keys?${params}`,
        ),
        'apiKeys',
      );
      return {
        appId: id,
        apiKeys: result.items.map((key) => safeKey(key, options.showSecrets)),
        pagination: result.pagination,
      };
    });
  }

  async deleteKey(id: string, fingerprint: string) {
    appId(id);
    if (!/^[0-9a-f]{64}$/.test(fingerprint))
      argument('Use the full keyId returned by apps keys list.');
    return this.auth.withStudioSession(async (session) => {
      let key: ObjectValue | undefined;
      try {
        key = await this.findKey(session, id, fingerprint);
      } catch (error) {
        // Deleting the parent app also removes all its keys.
        if (!(error instanceof CliError) || error.options.status !== 404)
          throw error;
      }
      await session.clearSelection(id, fingerprint);
      if (key) {
        const secret = string(key, 'apiKey');
        await this.remove(
          session,
          `/v1/apps/${encodeURIComponent(id)}/api-keys/${encodeURIComponent(secret)}`,
        );
      }
      return { appId: id, keyId: fingerprint, deleted: true };
    });
  }

  async listAvatars(
    options: Pages & { type?: string; statuses?: string[] } = {},
  ) {
    const type = options.type ?? 'custom';
    if (type !== 'custom' && type !== 'public')
      argument('--type must be public or custom.');
    const params = query(options);
    if (options.statuses !== undefined) {
      if (type !== 'custom')
        argument('--status is only supported for custom avatars.');
      for (const status of options.statuses) {
        if (!['success', 'generating', 'failure'].includes(status))
          argument('--status accepts success,generating,failure.');
        params.append(
          'statuses',
          `CUSTOM_AVATAR_STATUS_${status.toUpperCase()}`,
        );
      }
    }
    return this.auth.withStudioSession(async (session) => {
      const response = await session.request(
        `/v2/console/${type}-avatars?${params}`,
      );
      const result = page(
        response,
        type === 'public' ? 'publicAvatars' : 'avatars',
      );
      return {
        type,
        avatars: result.items,
        pagination: result.pagination,
        ...(type === 'custom' && response.counts !== undefined
          ? { counts: object(response.counts) }
          : {}),
      };
    });
  }

  createApp(options: CreationOptions) {
    return this.create('studio-app', options);
  }
  createKey(options: CreationOptions) {
    return this.create('studio-key', options);
  }

  async createSessionToken(id: string, fingerprint?: string) {
    appId(id);
    if (fingerprint !== undefined && !/^[0-9a-f]{64}$/.test(fingerprint))
      argument('Use the full keyId returned by apps keys list.');
    return this.auth.withStudioSession(async (session) => {
      const key = await this.findKey(session, id, fingerprint);
      if (!key)
        throw new CliError(
          'APP_KEY_UNAVAILABLE',
          'No matching API key is available for this app.',
          {
            recovery:
              'Run spatius apps keys list --app-id <APP_ID>. Create a key explicitly if the app has none; session-token generation never creates a key.',
          },
        );
      const secret = string(key, 'apiKey');
      const operationId = randomUUID();
      const input = {
        expireAt: Math.floor(Date.now() / 1000) + 24 * 3600,
        modelVersion: '',
      };
      const metadata = {
        appId: id,
        keyId: keyId(secret),
        consoleOrigin: session.consoleOrigin,
        ...input,
      };
      const journal = {
        version: 1,
        type: 'session-token',
        id: operationId,
        input: metadata,
        state: 'submitting',
      };
      const store = new StateStore(
        this.auth.stateDirectory(),
        session.profileKey,
      );
      await store.write(operationId, journal);
      this.progress({
        event: 'operation_saved',
        operationId,
        type: 'session-token',
      });
      try {
        const sessionToken = await session.createSessionToken(secret, input);
        journal.state = 'accepted';
        await store.write(operationId, journal);
        return { operationId, ...metadata, sessionToken };
      } catch (error) {
        const failure = error instanceof CliError ? error : undefined;
        const status = failure?.options.status;
        if (
          status !== undefined &&
          status >= 400 &&
          status < 500 &&
          status !== 408
        ) {
          journal.state = 'rejected';
          await store.write(operationId, journal);
        }
        throw new CliError(
          failure?.code ?? 'SESSION_TOKEN_FAILED',
          failure?.message ??
            'Session-token generation did not complete safely.',
          {
            status,
            exitCode: failure?.options.exitCode,
            retryable: false,
            details: { operationId, ...metadata },
            recovery:
              journal.state === 'rejected'
                ? 'Verify the app key and configured Console region/access before intentionally generating another token.'
                : 'A token may have been issued until expireAt. Tokens are not saved and cannot be resumed or recovered. Generate another token only when a new issuance is intended.',
          },
        );
      }
    });
  }

  private async create(type: Journal['type'], options: CreationOptions) {
    if (
      options.resume &&
      (options.name !== undefined || options.appId !== undefined)
    )
      argument('--resume cannot be combined with new creation input.');
    if (!options.resume && type === 'studio-app' && !options.name?.trim())
      argument('--name is required.');
    if (!options.resume && type === 'studio-key') appId(options.appId ?? '');
    const id = options.resume
      ? identifier(options.resume, 'Operation ID')
      : randomUUID();
    return this.auth.withStudioSession(async (session) => {
      const store = new StateStore(
        this.auth.stateDirectory(),
        session.profileKey,
      );
      let journal: Journal;
      if (options.resume) {
        journal = await store.read<Journal>(id);
        if (journal.version !== 1 || journal.type !== type || journal.id !== id)
          argument('The saved operation does not match this creation command.');
        if (journal.state !== 'accepted' || !journal.result)
          throw this.uncertain(journal);
      } else {
        journal = {
          version: 1,
          type,
          id,
          state: 'submitting',
          input:
            type === 'studio-app'
              ? { name: options.name!.trim() }
              : { appId: options.appId! },
        };
        await store.write(id, journal);
        this.progress({ event: 'operation_saved', operationId: id, type });
        try {
          if ('name' in journal.input) {
            const response = await session.request('/v1/apps', {
              body: { name: journal.input.name },
            });
            journal.result = {
              appId: string(response, 'appId'),
              name: journal.input.name,
            };
          } else {
            const response = await session.request(
              `/v1/apps/${encodeURIComponent(journal.input.appId)}/api-keys`,
              { body: {} },
            );
            journal.result = {
              appId: journal.input.appId,
              ...safeKey(response.apiKey),
            };
          }
          journal.state = 'accepted';
          await store.write(id, journal);
        } catch (error) {
          if (
            error instanceof CliError &&
            error.options.status !== undefined &&
            error.options.status >= 400 &&
            error.options.status < 500 &&
            error.options.status !== 408
          ) {
            journal.state = 'rejected';
            await store.write(id, journal);
            throw new CliError(error.code, error.message, {
              ...error.options,
              retryable: false,
              details: { operationId: id },
            });
          }
          if (error instanceof CliError && error.code === 'INTERRUPTED')
            throw new CliError(error.code, error.message, {
              ...error.options,
              details: { operationId: id },
              recovery: this.uncertain(journal).options.recovery,
            });
          throw this.uncertain(journal);
        }
      }
      if (type === 'studio-key' && options.showSecrets) {
        let key: ObjectValue | undefined;
        try {
          key = await this.findKey(
            session,
            string(journal.result!, 'appId'),
            string(journal.result!, 'keyId'),
          );
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          throw new CliError(error.code, error.message, {
            ...error.options,
            details: { operationId: id },
            recovery: `The key was created. Run spatius apps keys create --resume ${id} --show-secrets to retrieve it without creating another key.`,
          });
        }
        if (!key)
          throw new CliError(
            'APP_KEY_UNAVAILABLE',
            'The created key is no longer visible.',
            {
              details: { operationId: id },
              recovery:
                'Run spatius apps keys list --app-id <APP_ID>. Do not repeat creation automatically.',
            },
          );
        return { operationId: id, ...journal.result, ...safeKey(key, true) };
      }
      return { operationId: id, ...journal.result };
    });
  }

  private uncertain(journal: Journal) {
    return new CliError(
      journal.state === 'rejected'
        ? 'STUDIO_CREATION_REJECTED'
        : 'STUDIO_CREATION_UNCERTAIN',
      journal.state === 'rejected'
        ? 'Studio rejected this saved creation.'
        : 'Studio may have completed this creation; it will not be submitted again.',
      {
        details: { operationId: journal.id, input: journal.input },
        recovery:
          'Inspect spatius apps list or spatius apps keys list --app-id <APP_ID> to reconcile. Only start a new creation after checking the earlier outcome and intentionally choosing another attempt.',
      },
    );
  }

  private async findKey(
    session: StudioSession,
    id: string,
    fingerprint?: string,
  ): Promise<ObjectValue | undefined> {
    const seen = new Set<string>();
    let token = '';
    do {
      const result = page(
        await session.request(
          `/v1/apps/${encodeURIComponent(id)}/api-keys?${query({ pageSize: 100, pageToken: token })}`,
        ),
        'apiKeys',
      );
      const match = result.items.find(
        (key) =>
          fingerprint === undefined ||
          keyId(string(key, 'apiKey')) === fingerprint,
      );
      if (match) return match;
      token = result.pagination.nextPageToken;
      if (token && (seen.has(token) || seen.size >= 1000))
        throw invalidResponse();
      seen.add(token);
    } while (token);
    return undefined;
  }

  private async remove(session: StudioSession, path: string) {
    try {
      await session.request(path, { method: 'DELETE' });
    } catch (error) {
      if (!(error instanceof CliError) || error.options.status !== 404)
        throw error;
    }
  }
}
