/** Expected runtime failures; consumers translate these at their transport boundary. */
export class IsolationError extends Error {
  readonly code: "busy" | "disconnected" | "bad_request" | "not_found";
  constructor(code: IsolationError["code"], message: string) {
    super(message);
    this.name = "IsolationError";
    this.code = code;
  }
}
