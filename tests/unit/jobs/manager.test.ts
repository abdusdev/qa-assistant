import { describe, expect, it, vi } from 'vitest';
import { JobManager, isFinished } from '../../../src/jobs/manager.js';
import {
  RunError,
  type GenerateInput,
  type JobResult,
  type JobRunner,
  type RunnerContext,
  type RunnerOutcome,
} from '../../../src/jobs/types.js';

const input = (value = 'SHP-1'): GenerateInput => ({ mode: 'ticket', value });

const result = (cases = 0): JobResult => ({
  cases: Array.from({ length: cases }, (_, i) => ({ id: `TC-${i + 1}` })) as never,
  flow: { steps: [] },
  flowSource: 'none',
  tickets: [],
  warnings: [],
  grounding: { grounded: 0, partly: 0, assumed: 0 },
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  calls: 0,
  durationMs: 1,
  promptVersion: 'test',
});

/** A runner that waits until the test lets it finish, and remembers how it was called. */
function gatedRunner() {
  const started: RunnerContext[] = [];
  const gates: {
    release: (outcome?: Partial<RunnerOutcome>) => void;
    fail: (e: unknown) => void;
  }[] = [];

  const runner: JobRunner = (context) => {
    started.push(context);
    return new Promise<RunnerOutcome>((resolve, reject) => {
      gates.push({
        release: (outcome = {}) => resolve({ result: result(2), cancelled: false, ...outcome }),
        fail: reject,
      });
      context.signal.addEventListener('abort', () =>
        resolve({ result: result(0), cancelled: true }),
      );
    });
  };
  return { runner, started, gates };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('JobManager', () => {
  describe('starting a job', () => {
    it('returns at once with a queued or running job', () => {
      const { runner } = gatedRunner();
      const manager = new JobManager(runner);

      const job = manager.submit(input());

      expect(job.id).toBeTruthy();
      expect(['queued', 'running']).toContain(job.status);
      expect(job.input).toEqual(input());
      expect(job.cancelRequested).toBe(false);
    });

    it('runs the job and ends done with its result', async () => {
      const { runner, gates } = gatedRunner();
      const manager = new JobManager(runner);
      const job = manager.submit(input());
      await tick();

      expect(manager.get(job.id)?.status).toBe('running');
      expect(manager.get(job.id)?.startedAt).toBeDefined();

      gates[0]?.release({ runId: 'run-1' });
      await manager.whenIdle();

      const done = manager.get(job.id);
      expect(done?.status).toBe('done');
      expect(done?.result?.cases).toHaveLength(2);
      expect(done?.runId).toBe('run-1');
      expect(done?.finishedAt).toBeDefined();
      expect(done?.progress.stage).toBe('finished');
    });

    it('gives each job its own id', () => {
      const manager = new JobManager(gatedRunner().runner);

      expect(manager.submit(input()).id).not.toBe(manager.submit(input()).id);
    });

    it('returns a copy, so a caller cannot change the job', async () => {
      const { runner } = gatedRunner();
      const manager = new JobManager(runner);
      const job = manager.submit(input());

      job.status = 'done';
      job.input.value = 'changed';

      expect(manager.get(job.id)?.status).not.toBe('done');
      expect(manager.get(job.id)?.input.value).toBe('SHP-1');
    });
  });

  describe('progress', () => {
    it('follows the stage and each ticket the runner reports', async () => {
      const { runner, started, gates } = gatedRunner();
      const manager = new JobManager(runner);
      const job = manager.submit(input());
      await tick();

      const { report } = started[0] as RunnerContext;
      report({ type: 'stage', stage: 'generating' });
      report({ type: 'tickets', tickets: ['SHP-1', 'SHP-2', 'SHP-3'] });
      report({ type: 'ticket', ticket: 'SHP-1', status: 'ok', cases: 4 });
      report({ type: 'ticket', ticket: 'SHP-2', status: 'failed', error: 'boom' });
      report({ type: 'ticket', ticket: 'SHP-3', status: 'running' });

      const progress = manager.get(job.id)?.progress;
      expect(progress?.stage).toBe('generating');
      expect(progress?.total).toBe(3);
      expect(progress?.done).toBe(2);
      expect(progress?.tickets).toEqual([
        { ticket: 'SHP-1', status: 'ok', cases: 4 },
        { ticket: 'SHP-2', status: 'failed', error: 'boom' },
        { ticket: 'SHP-3', status: 'running' },
      ]);

      gates[0]?.release();
      await manager.whenIdle();
    });

    it('ignores a report for a ticket it does not know, and reports after the end', async () => {
      const { runner, started, gates } = gatedRunner();
      const manager = new JobManager(runner);
      const job = manager.submit(input());
      await tick();
      const { report } = started[0] as RunnerContext;

      report({ type: 'ticket', ticket: 'SHP-9', status: 'ok', cases: 1 });
      gates[0]?.release();
      await manager.whenIdle();
      report({ type: 'stage', stage: 'generating' });

      expect(manager.get(job.id)?.progress.tickets).toEqual([]);
      expect(manager.get(job.id)?.progress.stage).toBe('finished');
    });
  });

  describe('concurrency limit', () => {
    it('runs one at a time by default and starts the next when one ends', async () => {
      const { runner, started, gates } = gatedRunner();
      const manager = new JobManager(runner);
      const first = manager.submit(input('SHP-1'));
      const second = manager.submit(input('SHP-2'));
      await tick();

      expect(started).toHaveLength(1);
      expect(manager.get(first.id)?.status).toBe('running');
      expect(manager.get(second.id)?.status).toBe('queued');
      expect(manager.counts).toEqual({ queued: 1, running: 1 });

      gates[0]?.release();
      await tick();
      await tick();

      expect(manager.get(first.id)?.status).toBe('done');
      expect(manager.get(second.id)?.status).toBe('running');
      expect(started).toHaveLength(2);

      gates[1]?.release();
      await manager.whenIdle();
    });

    it('never runs more than the limit at the same time', async () => {
      let active = 0;
      let peak = 0;
      const runner: JobRunner = async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { result: result(), cancelled: false };
      };
      const manager = new JobManager(runner, { maxConcurrent: 2 });

      for (let i = 0; i < 6; i++) manager.submit(input(`SHP-${i}`));
      await manager.whenIdle();

      expect(peak).toBe(2);
      expect(manager.list().every((job) => job.status === 'done')).toBe(true);
    });
  });

  describe('failure', () => {
    it('fails the job with a message the caller may see for our own errors', async () => {
      const runner: JobRunner = async () => {
        throw new RunError('No tickets matched the input.');
      };
      const onError = vi.fn();
      const manager = new JobManager(runner, { onError });
      const job = manager.submit(input());
      await manager.whenIdle();

      expect(manager.get(job.id)).toMatchObject({
        status: 'failed',
        error: 'No tickets matched the input.',
      });
      expect(onError).not.toHaveBeenCalled();
    });

    it('does not show an unexpected error, but reports it for the log', async () => {
      const runner: JobRunner = async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
      };
      const onError = vi.fn();
      const manager = new JobManager(runner, { onError });
      const job = manager.submit(input());
      await manager.whenIdle();

      const failed = manager.get(job.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.error).toBe('The run failed unexpectedly. See the server log.');
      expect(JSON.stringify(failed)).not.toContain('hunter2');
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('keeps going with the next job after one fails', async () => {
      let calls = 0;
      const runner: JobRunner = async () => {
        calls++;
        if (calls === 1) throw new RunError('first failed');
        return { result: result(1), cancelled: false };
      };
      const manager = new JobManager(runner);
      const first = manager.submit(input('SHP-1'));
      const second = manager.submit(input('SHP-2'));
      await manager.whenIdle();

      expect(manager.get(first.id)?.status).toBe('failed');
      expect(manager.get(second.id)?.status).toBe('done');
    });
  });

  describe('cancel', () => {
    it('cancels a queued job without ever running it', async () => {
      const { runner, started, gates } = gatedRunner();
      const manager = new JobManager(runner);
      manager.submit(input('SHP-1'));
      const queued = manager.submit(input('SHP-2'));
      await tick();

      const cancelled = manager.cancel(queued.id);

      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.finishedAt).toBeDefined();
      expect(manager.counts).toEqual({ queued: 0, running: 1 });
      gates[0]?.release();
      await manager.whenIdle();
      expect(started).toHaveLength(1);
      expect(manager.get(queued.id)?.status).toBe('cancelled');
    });

    it('tells a running job to stop, and ends it as cancelled', async () => {
      const { runner, started } = gatedRunner();
      const manager = new JobManager(runner);
      const job = manager.submit(input());
      await tick();

      const response = manager.cancel(job.id);

      expect(response?.cancelRequested).toBe(true);
      expect(started[0]?.signal.aborted).toBe(true);
      await manager.whenIdle();
      expect(manager.get(job.id)?.status).toBe('cancelled');
    });

    it('ends as cancelled when the runner throws because it was stopped', async () => {
      const runner: JobRunner = ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const manager = new JobManager(runner);
      const job = manager.submit(input());
      await tick();

      manager.cancel(job.id);
      await manager.whenIdle();

      expect(manager.get(job.id)?.status).toBe('cancelled');
      expect(manager.get(job.id)?.error).toBeUndefined();
    });

    it('does not change a job that has finished, and returns undefined for an unknown one', async () => {
      const { runner, gates } = gatedRunner();
      const manager = new JobManager(runner);
      const job = manager.submit(input());
      await tick();
      gates[0]?.release();
      await manager.whenIdle();

      expect(manager.cancel(job.id)?.status).toBe('done');
      expect(manager.cancel('no-such-job')).toBeUndefined();
    });

    it('cancels everything for a shutdown', async () => {
      const { runner } = gatedRunner();
      const manager = new JobManager(runner);
      const running = manager.submit(input('SHP-1'));
      const queued = manager.submit(input('SHP-2'));
      await tick();

      manager.cancelAll();
      await manager.whenIdle();

      expect(manager.get(running.id)?.status).toBe('cancelled');
      expect(manager.get(queued.id)?.status).toBe('cancelled');
    });
  });

  describe('keeping jobs', () => {
    it('lists the newest first', () => {
      const manager = new JobManager(gatedRunner().runner, { maxConcurrent: 5 });
      const a = manager.submit(input('SHP-1'));
      const b = manager.submit(input('SHP-2'));

      expect(manager.list().map((job) => job.id)).toEqual([b.id, a.id]);
    });

    it('drops the oldest finished jobs beyond the limit and keeps the unfinished ones', async () => {
      const runner: JobRunner = async () => ({ result: result(), cancelled: false });
      const manager = new JobManager(runner, { maxStored: 3 });

      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        ids.push(manager.submit(input(`SHP-${i}`)).id);
        await manager.whenIdle();
      }

      expect(manager.list().length).toBeLessThanOrEqual(3);
      expect(manager.get(ids[0] as string)).toBeUndefined();
      expect(manager.get(ids[5] as string)?.status).toBe('done');
    });

    it('knows which statuses are final', () => {
      expect(['done', 'failed', 'cancelled'].every((s) => isFinished(s as never))).toBe(true);
      expect(isFinished('queued')).toBe(false);
      expect(isFinished('running')).toBe(false);
    });
  });
});
