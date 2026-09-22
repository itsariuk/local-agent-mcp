import { describe, it, expect } from "vitest";
import { WorkerPool } from "../pool.js";
import type { WorkerConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const W: WorkerConfig[] = [
  { id: "gpu0", host: "http://a", model: "m", provider: "ollama" },
  { id: "gpu1", host: "http://b", model: "m", provider: "ollama" },
];

const healthy = async () => true;

// Lets queued microtasks and health probes settle
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A job that records where it ran and stays running until the test opens it. */
function gatedJob(pool: WorkerPool, opts: { workerId?: string; signal?: AbortSignal } = {}) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const state = { workerId: undefined as string | undefined, open };
  const done = pool.run(async (worker) => {
    state.workerId = worker.id;
    await gate;
    return worker.id;
  }, opts);
  return Object.assign(state, { done });
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

describe("WorkerPool scheduling", () => {
  it("runs two jobs concurrently on different workers", async () => {
    const pool = new WorkerPool(W, healthy);
    const a = gatedJob(pool);
    const b = gatedJob(pool);
    await tick();

    expect([a.workerId, b.workerId].sort()).toEqual(["gpu0", "gpu1"]);

    a.open();
    b.open();
    await Promise.all([a.done, b.done]);
  });

  it("queues a third job and runs it on the first freed worker", async () => {
    const pool = new WorkerPool(W, healthy);
    const a = gatedJob(pool);
    const b = gatedJob(pool);
    const c = gatedJob(pool);
    await tick();
    expect(c.workerId).toBeUndefined();
    expect((await pool.status()).queued).toBe(1);

    const second = a.workerId === "gpu1" ? a : b;
    second.open();
    await tick();
    expect(c.workerId).toBe("gpu1");

    (second === a ? b : a).open();
    c.open();
    await Promise.all([a.done, b.done, c.done]);
  });

  it("serves the queue first-in first-out", async () => {
    const pool = new WorkerPool([W[0]!], healthy);
    const a = gatedJob(pool);
    const b = gatedJob(pool);
    const c = gatedJob(pool);
    await tick();

    a.open();
    await tick();
    expect(b.workerId).toBe("gpu0");
    expect(c.workerId).toBeUndefined();

    b.open();
    c.open();
    await Promise.all([a.done, b.done, c.done]);
  });

  it("waits for an explicitly requested worker without blocking other jobs", async () => {
    const pool = new WorkerPool(W, healthy);
    const a = gatedJob(pool); // gpu0
    const b = gatedJob(pool); // gpu1
    const x = gatedJob(pool, { workerId: "gpu1" });
    const y = gatedJob(pool);
    await tick();

    a.open(); // frees gpu0: x must keep waiting, y may go
    await tick();
    expect(x.workerId).toBeUndefined();
    expect(y.workerId).toBe("gpu0");

    b.open();
    await tick();
    expect(x.workerId).toBe("gpu1");

    x.open();
    y.open();
    await Promise.all([a.done, b.done, x.done, y.done]);
  });

  it("rejects an unknown worker id without running the job", async () => {
    const pool = new WorkerPool(W, healthy);
    let called = false;
    const run = pool.run(
      async () => {
        called = true;
      },
      { workerId: "nope" },
    );
    await expect(run).rejects.toThrow(/unknown worker: nope \(known: gpu0, gpu1\)/);
    expect(called).toBe(false);
  });

  it("does not hand one worker to two jobs started in the same tick", async () => {
    const slowHealth = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 10));
    const pool = new WorkerPool(W, slowHealth);
    const a = gatedJob(pool);
    const b = gatedJob(pool);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect([a.workerId, b.workerId].sort()).toEqual(["gpu0", "gpu1"]);

    a.open();
    b.open();
    await Promise.all([a.done, b.done]);
  });

  it("frees the worker when a job throws", async () => {
    const pool = new WorkerPool([W[0]!], healthy);
    await expect(
      pool.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await pool.run(async (w) => w.id)).toBe("gpu0");
  });
});

// ---------------------------------------------------------------------------
// Health and failover
// ---------------------------------------------------------------------------

describe("WorkerPool health", () => {
  it("fails over to the next worker at dispatch and reports the dead one", async () => {
    const pool = new WorkerPool(W, async (w) => w.host !== "http://a");
    expect(await pool.run(async (w) => w.id)).toBe("gpu1");

    const { workers } = await pool.status();
    expect(workers.find((w) => w.id === "gpu0")!.status).toBe("unhealthy");
    expect(workers.find((w) => w.id === "gpu1")!.status).toBe("idle");
  });

  it("rejects when every worker is unhealthy, without running the job", async () => {
    const pool = new WorkerPool(W, async () => false);
    let called = false;
    await expect(
      pool.run(async () => {
        called = true;
      }),
    ).rejects.toThrow(/no healthy worker/);
    expect(called).toBe(false);
  });

  it("uses a worker again once it recovers", async () => {
    let up = false;
    const pool = new WorkerPool([W[0]!], async () => up);
    await expect(pool.run(async (w) => w.id)).rejects.toThrow(/no healthy worker/);

    up = true;
    expect(await pool.run(async (w) => w.id)).toBe("gpu0");
    expect((await pool.status()).workers[0]!.status).toBe("idle");
  });

  it("drains the queue with an error when the last worker dies", async () => {
    let up = true;
    const pool = new WorkerPool([W[0]!], async () => up);
    const a = gatedJob(pool);
    const b = gatedJob(pool);
    await tick();

    up = false;
    a.open();
    await expect(b.done).rejects.toThrow(/no healthy worker/);
    expect(b.workerId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cancellation and status
// ---------------------------------------------------------------------------

describe("WorkerPool cancellation and status", () => {
  /** A job that ends only when its signal aborts; records the abort reason. */
  function abortableJob(pool: WorkerPool, opts: { signal?: AbortSignal } = {}) {
    const state = { reason: undefined as unknown };
    const done = pool.run(
      (w, _jobId, signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            state.reason = signal.reason;
            resolve(w.id);
          });
        }),
      opts,
    );
    return Object.assign(state, { done });
  }

  it("cancels a running job by id and frees the worker", async () => {
    const pool = new WorkerPool([W[0]!], healthy);
    const job = abortableJob(pool);
    await tick();
    const jobId = (await pool.status()).workers[0]!.job_id!;

    expect(pool.cancel("nope")).toBeUndefined();
    expect(pool.cancel(jobId)).toEqual({ workerId: "gpu0" });

    expect(await job.done).toBe("gpu0");
    expect((job.reason as Error).message).toContain("cancelled by local_cancel");
    expect((await pool.status()).workers[0]!.status).toBe("idle");
  });

  it("aborts a running job when the caller's signal aborts", async () => {
    const pool = new WorkerPool([W[0]!], healthy);
    const controller = new AbortController();
    const job = abortableJob(pool, { signal: controller.signal });
    await tick();

    controller.abort();

    expect(await job.done).toBe("gpu0");
  });

  it("drops a queued job when its signal aborts", async () => {
    const pool = new WorkerPool([W[0]!], healthy);
    const a = gatedJob(pool);
    const controller = new AbortController();
    const b = gatedJob(pool, { signal: controller.signal });
    await tick();

    controller.abort();
    await expect(b.done).rejects.toThrow(/cancelled/);
    expect((await pool.status()).queued).toBe(0);

    a.open();
    await a.done;
    await tick();
    expect(b.workerId).toBeUndefined();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const pool = new WorkerPool([W[0]!], healthy);
    const a = gatedJob(pool);
    await tick();
    const b = gatedJob(pool, { signal: AbortSignal.abort() });
    await expect(b.done).rejects.toThrow(/cancelled/);
    a.open();
    await a.done;
  });

  it("reports a claimed worker whose health probe is still running as probing", async () => {
    let answer!: (ok: boolean) => void;
    const pool = new WorkerPool([W[0]!], () => new Promise<boolean>((r) => (answer = r)));
    const run = pool.run(async (w) => w.id);
    await tick();

    expect((await pool.status()).workers[0]).toEqual({
      id: "gpu0",
      status: "probing",
      model: "m",
      provider: "ollama",
    });

    answer(true);
    expect(await run).toBe("gpu0");
  });

  it("reports the running job on a busy worker and nothing on an idle one", async () => {
    const pool = new WorkerPool(W, healthy);
    const a = gatedJob(pool);
    await tick();

    const { workers, queued } = await pool.status();
    const busy = workers.find((w) => w.id === a.workerId)!;
    const idle = workers.find((w) => w.id !== a.workerId)!;
    expect(queued).toBe(0);
    expect(busy).toMatchObject({ status: "busy", model: "m" });
    expect(busy.job_id).toMatch(/^[0-9a-f]{8}$/);
    expect(busy.busy_seconds).toBeTypeOf("number");
    expect(idle).toEqual({ id: idle.id, status: "idle", model: "m", provider: "ollama" });

    a.open();
    await a.done;
  });
});
