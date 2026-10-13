import type { CasePatch, NewCaseBody } from './lib/review.js';
import type {
  ApiCase,
  ApiErrorBody,
  ApiJob,
  ApiRun,
  ApiRunSummary,
  GenerateRequest,
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
      headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached. Check that it is running.');
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
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
