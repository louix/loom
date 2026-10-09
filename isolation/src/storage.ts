/** Consumer-owned identity mapping; paths must remain stable for an environment's lifetime. */
export interface EnvironmentStorage {
  directory(id: string): string;
  /** Recover and exclusively lock persistent state through the entire mutation. */
  withStopped<T>(id: string, action: () => Promise<T>): Promise<T>;
}
