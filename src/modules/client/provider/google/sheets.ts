import type { Request } from '../../../../utils/request';

export type CellValue = string | number | boolean | null;

type ValueInputOption = 'RAW' | 'USER_ENTERED';

interface ValueRange {
  range: string;
  majorDimension: 'ROWS' | 'COLUMNS';
  values?: CellValue[][];
}

interface UpdateResponse {
  updatedRange: string;
  updatedRows?: number;
  updatedCells?: number;
}

interface WriteOptions {
  valueInputOption?: ValueInputOption;
}

export function createSheets(request: Request) {
  const BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

  function url(spreadsheetId: string, range: string, suffix = ''): string {
    return `${BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}${suffix}`;
  }

  async function get(
    spreadsheetId: string,
    range: string,
  ): Promise<CellValue[][]> {
    const data = await request.json<ValueRange>(url(spreadsheetId, range), {
      params: { valueRenderOption: 'UNFORMATTED_VALUE' },
    });

    return data.values ?? [];
  }

  async function append(
    spreadsheetId: string,
    range: string,
    rows: CellValue[][],
    { valueInputOption = 'USER_ENTERED' }: WriteOptions = {},
  ): Promise<UpdateResponse | null> {
    if (rows.length === 0) return null;

    const data = await request.json<{ updates: UpdateResponse }>(
      url(spreadsheetId, range, ':append'),
      {
        method: 'POST',
        params: { valueInputOption, insertDataOption: 'INSERT_ROWS' },
        json: { values: rows },
      },
    );

    return data.updates;
  }

  async function update(
    spreadsheetId: string,
    range: string,
    rows: CellValue[][],
    { valueInputOption = 'USER_ENTERED' }: WriteOptions = {},
  ): Promise<UpdateResponse> {
    return request.json<UpdateResponse>(url(spreadsheetId, range), {
      method: 'PUT',
      params: { valueInputOption },
      json: { range, majorDimension: 'ROWS', values: rows },
    });
  }

  async function clear(spreadsheetId: string, range: string): Promise<void> {
    await request(url(spreadsheetId, range, ':clear'), { method: 'POST' });
  }

  return {
    get,
    append,
    update,
    clear,
  };
}

export type SheetsService = ReturnType<typeof createSheets>;
