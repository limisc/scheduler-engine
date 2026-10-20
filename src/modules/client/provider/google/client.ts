import type { ClientContext, TokenPayload } from '../../core/client.types';
import type { Account } from '../../../account/account.types';
import {
  type GoogleConfig,
  type OAuthResponse,
  TOKEN_URL,
} from './google.types';
import { createGmail, type GmailService } from './gmail';
import { createSheets, type SheetsService } from './sheets';
import { createDrive, type DriveService } from './drive';
import { request } from '../../../../utils/request';

export function createGoogleClient(
  account: Account,
  { getToken, updateCredential }: ClientContext,
  config: GoogleConfig,
) {
  let refreshToken = account.credential;

  let gmail: GmailService | undefined;
  let sheets: SheetsService | undefined;
  let drive: DriveService | undefined;

  async function refresh(): Promise<TokenPayload> {
    const data = await request.json<OAuthResponse>(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (data.refresh_token && data.refresh_token !== refreshToken) {
      refreshToken = data.refresh_token;
      await updateCredential(refreshToken);
    }

    return {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1_000,
    };
  }

  async function authorize(headers: Headers, force = false): Promise<boolean> {
    const token = await getToken(refresh, force);
    headers.set('Authorization', `Bearer ${token}`);
    return true;
  }

  const _request = request.with({
    auth: {
      authorize,
      refresh: (headers: Headers) => authorize(headers, true),
    },
  });

  return {
    request: _request,

    get gmail() {
      return (gmail ??= createGmail(_request));
    },

    get sheets() {
      return (sheets ??= createSheets(_request));
    },

    get drive() {
      return (drive ??= createDrive(_request));
    },
  };
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
