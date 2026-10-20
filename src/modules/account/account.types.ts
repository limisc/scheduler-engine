import type { Provider } from '../client/provider';

export interface AccountRow {
  id: string;
  provider: string;
  name: string;
  credential: string;
  config: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Account {
  id: string;
  provider: Provider;
  name: string;
  credential: string;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export type AccountPublic = Omit<Account, 'credential' | 'config'> & {
  config_keys: string[];
};

export interface UpsertAccountInput {
  provider: string;
  name: string;
  credential: string;
  config?: Record<string, unknown>;
}

export interface UpdateAccountInput {
  name?: string;
  credential?: string;
  config?: Record<string, unknown> | null;
}
