export class AsyncLimiter {
  private active = 0
  private readonly pending: Array<() => void> = []

  constructor(readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('invalid_concurrency_limit')
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await operation()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maximum) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.pending.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active -= 1
    this.pending.shift()?.()
  }
}
