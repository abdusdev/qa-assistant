import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { isFinished } from './lib/view.js';
import type { ApiJob } from './lib/types.js';
import { parseRoute, type Route } from './hooks-route.js';

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const go = (path: string) => {
  window.location.hash = path;
};

export interface JobState {
  job: ApiJob | undefined;
  error: ApiError | undefined;
  /** True until the first answer arrives. */
  loading: boolean;
  refresh: () => void;
}

/** Reads a job every second until it has finished. */
export function useJob(id: string, intervalMs = 1000): JobState {
  const [job, setJob] = useState<ApiJob | undefined>();
  const [error, setError] = useState<ApiError | undefined>();
  const [loading, setLoading] = useState(true);
  const stopped = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const read = useCallback(async () => {
    try {
      const next = await api.job(id);
      if (stopped.current) return;
      setJob(next);
      setError(undefined);
      setLoading(false);
      if (!isFinished(next.status)) timer.current = setTimeout(() => void read(), intervalMs);
    } catch (caught) {
      if (stopped.current) return;
      setLoading(false);
      const failure =
        caught instanceof ApiError ? caught : new ApiError(0, 'unknown', 'Something went wrong.');
      setError(failure);
      // A lost connection is worth another try; a missing job is not.
      if (failure.code === 'network') timer.current = setTimeout(() => void read(), intervalMs * 3);
    }
  }, [id, intervalMs]);

  useEffect(() => {
    stopped.current = false;
    setJob(undefined);
    setError(undefined);
    setLoading(true);
    void read();
    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [read]);

  return { job, error, loading, refresh: () => void read() };
}
