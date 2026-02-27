declare function lockdown(opts?: { errorTaming?: string; consoleTaming?: string }): void
declare function harden<T>(obj: T): T
declare class Compartment {
  constructor(endowments?: Record<string, any>)
  evaluate(code: string): any
}
