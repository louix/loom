/**
 * The permission / question / plan-review parking pattern every adapter
 * repeats: mint an id, park a `Promise` keyed on it, resolve-and-delete when
 * the answer comes back (first writer wins — a second resolve on the same id
 * is a silent no-op), and drain everything on interrupt/close. Vendor-neutral:
 * callers keep minting ids and emitting `HarnessEvent`s themselves, since both
 * differ per adapter (Claude keys permissions off the SDK's own
 * `toolUseID`/`requestId`; aisdk mints `randomUUID()`).
 *
 * Generic over the permission/plan resolve value because adapters disagree on
 * shape (aisdk resolves permissions with `{allow, message?}`; Claude resolves
 * with its SDK's own `PermissionResult | null`) — forcing one shared shape
 * here would change behavior, not just relocate it.
 */
export class PendingInteractions<TPermission, TPlan> {
  readonly #perms = new Map<string, (value: TPermission) => void>();
  readonly #questions = new Map<string, (text: string) => void>();
  readonly #plans = new Map<string, (value: TPlan) => void>();

  requestPermission(id: string): Promise<TPermission> {
    return new Promise((resolve) => this.#perms.set(id, resolve));
  }

  requestQuestion(id: string): Promise<string> {
    return new Promise((resolve) => this.#questions.set(id, resolve));
  }

  requestPlan(id: string): Promise<TPlan> {
    return new Promise((resolve) => this.#plans.set(id, resolve));
  }

  /** True while `id` is still parked — lets a caller with several possible resolve values (branching on a decision) check "is this still live" before picking one, matching the resolve methods' own "unknown id → no-op" semantics. */
  hasPlan(id: string): boolean {
    return this.#plans.has(id);
  }

  /** Resolves and forgets the pending permission. Returns false if `id` is unknown or already resolved. */
  resolvePermission(id: string, value: TPermission): boolean {
    const resolve = this.#perms.get(id);
    if (!resolve) return false;
    this.#perms.delete(id);
    resolve(value);
    return true;
  }

  /** Resolves and forgets the pending question. Returns false if `id` is unknown or already resolved. */
  resolveQuestion(id: string, text: string): boolean {
    const resolve = this.#questions.get(id);
    if (!resolve) return false;
    this.#questions.delete(id);
    resolve(text);
    return true;
  }

  /** Resolves and forgets the pending plan review. Returns false if `id` is unknown or already resolved. */
  resolvePlan(id: string, value: TPlan): boolean {
    const resolve = this.#plans.get(id);
    if (!resolve) return false;
    this.#plans.delete(id);
    resolve(value);
    return true;
  }

  /** Drain every parked interaction (interrupt/close) so a gated tool call unwinds instead of hanging forever. */
  failAll(permissionValue: TPermission, questionPrefix: string, planValue: TPlan): void {
    for (const [, resolve] of this.#perms) resolve(permissionValue);
    this.#perms.clear();
    for (const [, resolve] of this.#questions) resolve(questionPrefix);
    this.#questions.clear();
    for (const [, resolve] of this.#plans) resolve(planValue);
    this.#plans.clear();
  }
}
