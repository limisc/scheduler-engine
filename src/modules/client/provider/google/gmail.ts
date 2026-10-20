import pLimit from 'p-limit';
import type { Request } from '../../../../utils/request';
import { decodeUrl, encode, encodeUrl } from '../../../../utils/common';

export interface GmailThread {
  id: string;
  snippet: string;
  historyId: string;
}

/** Anything with a thread id, e.g. a search result or `{ id: m.threadId }`. */
export type ThreadRef = Pick<GmailThread, 'id'>;

interface GmailMessageRef {
  id: string;
  threadId: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType: string;
  headers?: GmailHeader[];
  body?: { data?: string; size: number };
  parts?: GmailPart[];
}

interface GmailMessageFull extends GmailMessageRef {
  snippet: string;
  labelIds?: string[];
  internalDate: string;
  payload?: GmailPart;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
}

interface SendOptions {
  recipient: string;
  subject: string;
  body: string;
  html?: boolean;
}

interface WatchOptions {
  topicName: string;
  labelIds: string[];
  labelFilterBehavior?: 'INCLUDE' | 'EXCLUDE';
}

interface WatchResponse {
  historyId: string;
  expiration: string;
}

export function createGmail(request: Request) {
  const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const labels = new Map<string, string>();
  const limit = pLimit(8);
  let inFlight: Promise<void> | null = null;

  async function search(q: string, maxResults = 100): Promise<GmailThread[]> {
    const { threads } = await request.json<{ threads?: GmailThread[] }>(
      `${BASE_URL}/threads`,
      { params: { q, maxResults } },
    );

    return threads ?? [];
  }

  /** Messages matching `q`, with the common headers resolved. */
  async function messages(q: string, maxResults = 50): Promise<GmailMessage[]> {
    const { messages: refs } = await request.json<{
      messages?: GmailMessageRef[];
    }>(`${BASE_URL}/messages`, { params: { q, maxResults } });

    if (!refs?.length) return [];

    return Promise.all(
      refs.map(({ id }) =>
        limit(async () => {
          const m = await request.json<GmailMessageFull>(
            `${BASE_URL}/messages/${id}`,
            {
              params: {
                format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date'],
              },
            },
          );

          const header = (name: string) =>
            m.payload?.headers?.find(
              (h) => h.name.toLowerCase() === name.toLowerCase(),
            )?.value ?? '';

          return {
            id: m.id,
            threadId: m.threadId,
            from: header('From'),
            to: header('To'),
            subject: header('Subject'),
            date: new Date(Number(m.internalDate)).toISOString(),
            snippet: m.snippet,
            labelIds: m.labelIds ?? [],
          };
        }),
      ),
    );
  }

  async function archive(threads: ThreadRef[]): Promise<void> {
    await modify(threads, { removeLabelIds: ['INBOX'] });
  }

  async function trash(threads: ThreadRef[]): Promise<void> {
    await batch(threads, (id) =>
      request(`${BASE_URL}/threads/${id}/trash`, { method: 'POST' }),
    );
  }

  async function label(threads: ThreadRef[], name: string): Promise<void> {
    const labelId = await getLabelId(name);
    await modify(threads, { addLabelIds: [labelId] });
  }

  async function drop(threads: ThreadRef[], names: string[]): Promise<void> {
    const labelIds = await Promise.all(names.map((name) => getLabelId(name)));
    await modify(threads, { removeLabelIds: labelIds });
  }

  async function getLabelId(name: string): Promise<string> {
    const key = name.toLowerCase();

    let cached = labels.get(key);
    if (cached) return cached;

    if (!inFlight) {
      inFlight = (async () => {
        const data = await request.json<{ labels?: GmailLabel[] }>(
          `${BASE_URL}/labels`,
        );

        for (const { id, name } of data.labels ?? []) {
          if (id && name) {
            labels.set(name.toLowerCase(), id);
          }
        }
      })().finally(() => {
        inFlight = null;
      });
    }

    await inFlight;

    cached = labels.get(key);
    if (!cached) {
      throw new Error(`Unknown label ${name}`);
    }

    return cached;
  }

  async function modify(
    threads: ThreadRef[],
    options: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<void> {
    return batch(threads, (id) =>
      request(`${BASE_URL}/threads/${id}/modify`, {
        method: 'POST',
        json: options,
      }),
    );
  }

  async function batch(
    threads: ThreadRef[],
    action: (id: string) => Promise<unknown>,
  ): Promise<void> {
    const valid = threads
      .map((t) => t.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (valid.length === 0) return;

    const results = await Promise.allSettled(
      valid.map((id) => limit(() => action(id))),
    );

    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason);

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `[Gmail] batch operation failed for ${errors.length}/${valid.length} threads`,
      );
    }
  }

  async function send({
    recipient,
    subject,
    body,
    html = false,
  }: SendOptions): Promise<void> {
    const lines = [
      `To: ${recipient}`,
      `Content-Type: text/${html ? 'html' : 'plain'}; charset=UTF-8`,
      'Content-Transfer-Encoding: 8bit',
      'MIME-Version: 1.0',
      `Subject: =?UTF-8?B?${encode(subject)}?=`,
      '',
      body,
    ].join('\r\n');

    const raw = encodeUrl(lines);

    await request(`${BASE_URL}/messages/send`, {
      method: 'POST',
      json: { raw },
    });
  }

  /** Plain text body of the newest message matching `q`. */
  async function receive(q: string): Promise<string | undefined> {
    const res1 = await request.json<{ messages?: GmailMessageRef[] }>(
      `${BASE_URL}/messages`,
      { params: { q, maxResults: 1 } },
    );

    const id = res1.messages?.[0]?.id;

    if (!id) return;

    return body(id);
  }

  /** Plain text body of a message (HTML is reduced to text as fallback). */
  async function body(id: string): Promise<string | undefined> {
    const m = await request.json<GmailMessageFull>(
      `${BASE_URL}/messages/${id}`,
      { params: { format: 'full' } },
    );

    if (!m.payload) return;

    const text = findPart(m.payload, 'text/plain');
    if (text) return text;

    const html = findPart(m.payload, 'text/html');
    return html ? htmlToText(html) : undefined;
  }

  async function watch({
    topicName,
    labelIds,
    labelFilterBehavior = 'INCLUDE',
  }: WatchOptions): Promise<WatchResponse> {
    return await request.json<WatchResponse>(`${BASE_URL}/watch`, {
      method: 'POST',
      json: { topicName, labelIds, labelFilterBehavior },
    });
  }

  return {
    search,
    messages,
    archive,
    trash,
    label,
    drop,
    send,
    receive,
    body,
    watch,
  };
}

export type GmailService = ReturnType<typeof createGmail>;

function findPart(part: GmailPart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeUrl(part.body.data);
  }

  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
