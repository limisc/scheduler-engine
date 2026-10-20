import type { Request } from '../../../../utils/request';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
}

interface ListOptions {
  pageSize?: number;
  orderBy?: string;
}

interface UploadOptions {
  name: string;
  content: string | Blob | Uint8Array;
  mimeType?: string;
  parents?: string[];
}

const FIELDS = 'id,name,mimeType,parents,modifiedTime,size';

export function createDrive(request: Request) {
  const BASE_URL = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

  /** Files matching a Drive query, e.g. `'<folderId>' in parents`. */
  async function list(
    q: string,
    { pageSize = 100, orderBy = 'modifiedTime desc' }: ListOptions = {},
  ): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;

    do {
      const data = await request.json<{
        files: DriveFile[];
        nextPageToken?: string;
      }>(BASE_URL, {
        params: {
          q: `(${q}) and trashed = false`,
          pageSize,
          orderBy,
          pageToken,
          fields: `nextPageToken,files(${FIELDS})`,
        },
      });

      files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);

    return files;
  }

  async function upload({
    name,
    content,
    mimeType = 'application/octet-stream',
    parents,
  }: UploadOptions): Promise<DriveFile> {
    const form = new FormData();

    form.append(
      'metadata',
      new Blob([JSON.stringify({ name, mimeType, parents })], {
        type: 'application/json',
      }),
    );
    form.append(
      'file',
      content instanceof Blob
        ? content
        : new Blob([content], { type: mimeType }),
    );

    return request.json<DriveFile>(UPLOAD_URL, {
      method: 'POST',
      params: { uploadType: 'multipart', fields: FIELDS },
      body: () => form,
    });
  }

  /** Replaces the content of an existing file. */
  async function replace(
    id: string,
    content: string | Blob | Uint8Array,
    mimeType = 'application/octet-stream',
  ): Promise<DriveFile> {
    return request.json<DriveFile>(`${UPLOAD_URL}/${id}`, {
      method: 'PATCH',
      params: { uploadType: 'media', fields: FIELDS },
      headers: { 'Content-Type': mimeType },
      body: content instanceof Blob ? content : new Blob([content]),
    });
  }

  async function download(id: string): Promise<Blob> {
    return request.blob(`${BASE_URL}/${id}`, { params: { alt: 'media' } });
  }

  /** Exports a Google Docs/Sheets/Slides file, e.g. as text/plain or PDF. */
  async function exportAs(id: string, mimeType: string): Promise<Blob> {
    return request.blob(`${BASE_URL}/${id}/export`, { params: { mimeType } });
  }

  async function remove(id: string): Promise<void> {
    await request(`${BASE_URL}/${id}`, { method: 'DELETE' });
  }

  return {
    list,
    upload,
    replace,
    download,
    export: exportAs,
    remove,
  };
}

export type DriveService = ReturnType<typeof createDrive>;
