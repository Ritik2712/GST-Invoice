/**
 * Minimal FIFO mutex. Every write in the store funnels through one of these so two
 * concurrent requests can never interleave a read-modify-write on the same JSON file.
 * Single process only - which is exactly what this app is (one `next start`, one store).
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    // Chain onto the tail regardless of whether the previous task resolved or rejected.
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** Named locks, so settings writes do not queue behind invoice generation. */
const locks = new Map<string, Mutex>()

export function withLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  let mutex = locks.get(name)
  if (!mutex) {
    mutex = new Mutex()
    locks.set(name, mutex)
  }
  return mutex.run(task)
}
