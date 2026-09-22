// Worker pool — one job per worker at a time, FIFO queue for the rest.
// Health is probed at dispatch only: no timers, no background state.

import { randomUUID } from "node:crypto";
import { checkHealth } from "./ollama.js";
import type { WorkerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerStatus = "idle" | "busy" | "unhealthy";

export type HealthFn = (host: string) => Promise<boolean>;

// snake_case: this is the JSON the supervisor reads
export interface WorkerSnapshot {
  id: string;
  // "probing": claimed for a job whose health probe has not answered yet
  status: WorkerStatus | "probing";
  model: string;
  job_id?: string;
  busy_seconds?: number;
}

export interface PoolStatus {
  workers: WorkerSnapshot[];
  queued: number;
}

export interface RunOptions {
  workerId?: string;
  signal?: AbortSignal;
}

interface WorkerState extends WorkerConfig {
  status: WorkerStatus;
  jobId?: string;
  busySince?: number;
  controller?: AbortController;
}

export type Job<T> = (worker: WorkerConfig, jobId: string, signal: AbortSignal) => Promise<T>;

interface Waiter {
  workerId?: string;
  resolve: (worker: WorkerState) => void;
}

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

export class WorkerPool {
  private readonly workers: WorkerState[];
  private readonly queue: Waiter[] = [];

  constructor(
    configs: readonly WorkerConfig[],
    private readonly healthFn: HealthFn = checkHealth,
  ) {
    this.workers = configs.map((c) => ({ ...c, status: "idle" as const }));
  }

  /**
   * Run `job` on the first free healthy worker, or wait in the queue for one.
   * A dead worker is skipped at dispatch. A job is never moved to another
   * worker once it has started — it may already have written files.
   */
  async run<T>(job: Job<T>, opts: RunOptions = {}): Promise<T> {
    const { workerId, signal } = opts;
    if (workerId !== undefined && !this.workers.some((w) => w.id === workerId)) {
      const known = this.workers.map((w) => w.id).join(", ");
      throw new Error(`unknown worker: ${workerId} (known: ${known})`);
    }

    for (;;) {
      // Probe each free candidate once per pass
      const tried = new Set<string>();
      let worker = this.claim(workerId, tried);
      while (worker) {
        if (await this.healthFn(worker.host)) return await this.execute(worker, job, signal);
        console.error(`[pool] worker ${worker.id} unhealthy at ${worker.host}`);
        tried.add(worker.id);
        this.release(worker, "unhealthy");
        worker = this.claim(workerId, tried);
      }

      if (!this.candidates(workerId).some((w) => w.status === "busy")) {
        throw new Error("no healthy worker available -- check local_worker_status");
      }

      worker = await this.enqueue(workerId, signal);
      if (await this.healthFn(worker.host)) return await this.execute(worker, job, signal);
      console.error(`[pool] worker ${worker.id} unhealthy at ${worker.host}`);
      this.release(worker, "unhealthy");
    }
  }

  /** Abort a running job. Returns the worker it ran on, or undefined if no such job is running. */
  cancel(jobId: string): { workerId: string } | undefined {
    const worker = this.workers.find((w) => w.jobId === jobId);
    if (!worker?.controller) return undefined;
    worker.controller.abort(new Error("cancelled by local_cancel"));
    console.error(`[pool] job ${jobId} on ${worker.id} cancelled`);
    return { workerId: worker.id };
  }

  /** Snapshot for the supervisor. Probes every worker that is not busy. */
  async status(): Promise<PoolStatus> {
    await Promise.all(
      this.workers
        .filter((w) => w.status !== "busy")
        .map(async (w) => {
          const ok = await this.healthFn(w.host);
          // A job may have claimed the worker while the probe was in flight
          if (w.status !== "busy") w.status = ok ? "idle" : "unhealthy";
        }),
    );

    return {
      workers: this.workers.map((w) => ({
        id: w.id,
        status: w.status === "busy" && w.jobId === undefined ? "probing" : w.status,
        model: w.model,
        ...(w.jobId !== undefined && { job_id: w.jobId }),
        ...(w.busySince !== undefined && {
          busy_seconds: Math.round((Date.now() - w.busySince) / 1000),
        }),
      })),
      queued: this.queue.length,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private candidates(workerId?: string): WorkerState[] {
    return workerId === undefined ? this.workers : this.workers.filter((w) => w.id === workerId);
  }

  /** Synchronous on purpose: marking busy before any await is what prevents a double claim. */
  private claim(workerId: string | undefined, tried: Set<string>): WorkerState | undefined {
    const worker = this.candidates(workerId).find((w) => w.status !== "busy" && !tried.has(w.id));
    if (worker) worker.status = "busy";
    return worker;
  }

  private async execute<T>(
    worker: WorkerState,
    job: Job<T>,
    clientSignal?: AbortSignal,
  ): Promise<T> {
    worker.jobId = randomUUID().slice(0, 8);
    worker.busySince = Date.now();
    worker.controller = new AbortController();
    // local_cancel and a client disconnect both abort the running job
    const signal = clientSignal
      ? AbortSignal.any([worker.controller.signal, clientSignal])
      : worker.controller.signal;
    try {
      return await job(
        { id: worker.id, host: worker.host, model: worker.model },
        worker.jobId,
        signal,
      );
    } finally {
      // Most job errors are not outages, and the next dispatch probes anyway
      this.release(worker, "idle");
    }
  }

  /**
   * Free a worker and hand it to the first compatible waiter. An unhealthy
   * worker is handed over too: the waiter probes it, fails, and reaches the
   * "no healthy worker" check — so the queue drains instead of hanging.
   */
  private release(worker: WorkerState, status: "idle" | "unhealthy"): void {
    worker.jobId = undefined;
    worker.busySince = undefined;
    worker.controller = undefined;
    worker.status = status;

    const index = this.queue.findIndex((w) => w.workerId === undefined || w.workerId === worker.id);
    if (index === -1) return;
    const [waiter] = this.queue.splice(index, 1);
    worker.status = "busy";
    waiter!.resolve(worker);
  }

  private enqueue(workerId: string | undefined, signal?: AbortSignal): Promise<WorkerState> {
    return new Promise<WorkerState>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("cancelled while queued"));
        return;
      }
      const waiter: Waiter = { workerId, resolve };
      this.queue.push(waiter);
      signal?.addEventListener(
        "abort",
        () => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return; // already dispatched
          this.queue.splice(index, 1);
          reject(new Error("cancelled while queued"));
        },
        { once: true },
      );
    });
  }
}
