import type { AuthStore } from '../../core/auth.store';
import type { AuthHandler, AuthResult } from '../../core/client.types';
import {
  type GoogleConfig,
  type OAuthResponse,
  TOKEN_URL,
} from './google.types';
import { request } from '../../../../utils/request';

const DEFAULT_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

export function createGoogleAuth(
  authStore: AuthStore,
  config: GoogleConfig,
): AuthHandler {
  const {
    clientId,
    clientSecret,
    redirectUri,
    scopes = DEFAULT_SCOPES,
  } = config;

  function getAuthUrl(name: string): string {
    const state = authStore.create(name);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes.join(' '),
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async function handleCallback(params: URLSearchParams): Promise<AuthResult> {
    const error = params.get('error');
    if (error) {
      throw new Error(`[GoogleAuth] Authorization denied: ${error}`);
    }

    const name = authStore.take(params.get('state') ?? '');
    if (!name) {
      throw new Error('[GoogleAuth] Invalid or expired OAuth state');
    }

    const code = params.get('code');
    if (!code) {
      throw new Error('[GoogleAuth] Missing authorization code');
    }

    const data = await request.json<OAuthResponse>(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!data.refresh_token) {
      throw new Error(
        '[GoogleAuth] Failed to obtain refresh_token from Google',
      );
    }

    return {
      name,
      credential: data.refresh_token,
      payload: {
        token: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1_000,
      },
    };
  }

  return {
    getAuthUrl,
    handleCallback,
  };
}
