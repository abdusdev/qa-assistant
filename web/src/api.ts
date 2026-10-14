import type { CasePatch, NewCaseBody } from './lib/review.js';
import { announceAuthRequired, authHeaders } from './session.js';
import type {
  ApiCase,
  ApiErrorBody,
  ApiJob,
  ApiRun,
  ApiRunSummary,
  GenerateRequest,
  TicketDetail,
} from './lib/types.js';

/** An answer from the API that was an error, with the message it gave. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: { field: string; problem: string }[];

  constructor(status: number, code: string, message: string, details: ApiError['details'] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...authHeaders(),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached. Check that it is running.');
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    // The session check is how the page finds out; announcing it would make it check again.
    if (response.status === 401 && path !== '/api/session') announceAuthRequired();
    const error = (body as ApiErrorBody | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `The server answered ${response.status}.`,
      error?.details ?? [],
    );
  }
  return body as T;
}

export const api = {
  start: (request: GenerateRequest) =>
    call<{ jobId: string; status: string }>('/api/generate', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  job: (id: string) => call<ApiJob>(`/api/jobs/${encodeURIComponent(id)}`),
  jobTickets: (id: string) =>
    call<{ tickets: TicketDetail[] }>(`/api/jobs/${encodeURIComponent(id)}/tickets`),
  cancel: (id: string) =>
    call<unknown>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  runs: (limit = 20) => call<{ runs: ApiRunSummary[] }>(`/api/runs?limit=${limit}`),
  run: (id: string) => call<ApiRun>(`/api/runs/${encodeURIComponent(id)}`),
};

// ---- reviewing a saved run ---------------------------------------------------------------------

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const review = {
  edit: (uid: string, patch: CasePatch) =>
    call<ApiCase>(`/api/cases/${encodeURIComponent(uid)}`, { method: 'PATCH', ...json(patch) }),
  remove: (uid: string) =>
    call<{ deleted: boolean }>(`/api/cases/${encodeURIComponent(uid)}`, { method: 'DELETE' }),
  restore: (uid: string) =>
    call<ApiCase>(`/api/cases/${encodeURIComponent(uid)}/restore`, { method: 'POST' }),
  approve: (uid: string, approved: boolean) =>
    call<ApiCase>(`/api/cases/${encodeURIComponent(uid)}/approve`, {
      method: 'POST',
      ...json({ approved }),
    }),
  move: (uid: string, direction: 'up' | 'down') =>
    call<{ moved: boolean }>(`/api/cases/${encodeURIComponent(uid)}/move`, {
      method: 'POST',
      ...json({ direction }),
    }),
  add: (runId: string, body: NewCaseBody) =>
    call<ApiCase>(`/api/runs/${encodeURIComponent(runId)}/cases`, {
      method: 'POST',
      ...json(body),
    }),
  approveAll: (runId: string) =>
    call<{ approved: number }>(`/api/runs/${encodeURIComponent(runId)}/approve-all`, {
      method: 'POST',
    }),
  regenerate: (runId: string, ticket: string) =>
    call<{ jobId: string }>(`/api/runs/${encodeURIComponent(runId)}/regenerate`, {
      method: 'POST',
      ...json({ ticket }),
    }),
};

/** Downloads a file the server makes, sending the token, and saves it under the name it gives. */
export async function downloadFile(path: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, { headers: authHeaders() });
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached. Check that it is running.');
  }
  if (!response.ok) {
    if (response.status === 401) announceAuthRequired();
    const body = (await response.json().catch(() => undefined)) as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      body?.error.code ?? 'unknown',
      body?.error.message ?? `The server answered ${response.status}.`,
    );
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'test-cases';
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Asks the server who is using it. A 401 means a token is needed (or was not accepted). */
export const session = () => call<{ authRequired: boolean; user: string }>('/api/session');
