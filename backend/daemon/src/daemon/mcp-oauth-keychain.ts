import { McpOAuthError } from "./mcp-oauth-model.ts";

/** Direct Security.framework calls: no secret-bearing argv, shell or plaintext fallback. */
export const oauthKeychainNative = (service: string, value?: string): string | undefined => {
  if (Deno.build.os !== "darwin") throw new McpOAuthError("storage_unavailable");
  let cf: ReturnType<typeof foundation> | undefined;
  let sec: ReturnType<typeof security> | undefined;
  const allocated: Deno.PointerValue[] = [];
  try {
    cf = foundation();
    sec = security();
    const c = cf.symbols,
      s = sec.symbols;
    const own = (p: Deno.PointerValue) => {
      if (!p) throw new McpOAuthError("storage_unavailable");
      allocated.push(p);
      return p;
    };
    const string = (text: string) =>
      own(c.CFStringCreateWithCString(null, new TextEncoder().encode(text + "\0"), 0x08000100));
    const dictionary = () => own(c.CFDictionaryCreateMutable(null, 0n, null, null));
    const query = dictionary();
    const set = (d: Deno.PointerValue, k: Deno.PointerValue, v: Deno.PointerValue) =>
      c.CFDictionarySetValue(d, k, v);
    set(query, s.kSecClass, s.kSecClassGenericPassword);
    set(query, s.kSecAttrService, string(service));
    set(query, s.kSecAttrAccount, string("loom-mcp-oauth"));
    set(query, s.kSecUseAuthenticationUI, s.kSecUseAuthenticationUIFail);
    if (value !== undefined) {
      const bytes = new TextEncoder().encode(value);
      if (bytes.length > 262144) throw new McpOAuthError("storage_corrupt");
      const data = own(c.CFDataCreate(null, bytes, BigInt(bytes.length)));
      const attrs = dictionary();
      set(attrs, s.kSecValueData, data);
      let status = s.SecItemUpdate(query, attrs);
      if (status === -25300) {
        set(query, s.kSecValueData, data);
        status = s.SecItemAdd(query, null);
      }
      if (status !== 0) throw new McpOAuthError("storage_unavailable");
      return;
    }
    set(query, s.kSecReturnData, c.kCFBooleanTrue);
    set(query, s.kSecMatchLimit, s.kSecMatchLimitOne);
    const output = new BigUint64Array(1);
    const status = s.SecItemCopyMatching(query, output);
    if (status === -25300) return;
    if (status !== 0) throw new McpOAuthError("storage_unavailable");
    const data = own(Deno.UnsafePointer.create(output[0]!));
    const length = Number(c.CFDataGetLength(data));
    if (length < 1 || length > 262144) throw new McpOAuthError("storage_corrupt");
    const pointer = c.CFDataGetBytePtr(data);
    if (!pointer) throw new McpOAuthError("storage_corrupt");
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(new Deno.UnsafePointerView(pointer).getArrayBuffer(length)),
    );
  } catch (error) {
    throw error instanceof McpOAuthError ? error : new McpOAuthError("storage_unavailable");
  } finally {
    for (const pointer of allocated.reverse()) cf?.symbols.CFRelease(pointer);
    sec?.close();
    cf?.close();
  }
};
const foundation = () =>
  Deno.dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFStringCreateWithCString: { parameters: ["pointer", "buffer", "u32"], result: "pointer" },
    CFDictionaryCreateMutable: {
      parameters: ["pointer", "isize", "pointer", "pointer"],
      result: "pointer",
    },
    CFDictionarySetValue: { parameters: ["pointer", "pointer", "pointer"], result: "void" },
    CFDataCreate: { parameters: ["pointer", "buffer", "isize"], result: "pointer" },
    CFDataGetLength: { parameters: ["pointer"], result: "isize" },
    CFDataGetBytePtr: { parameters: ["pointer"], result: "pointer" },
    CFRelease: { parameters: ["pointer"], result: "void" },
    kCFBooleanTrue: { type: "pointer" },
  });
const security = () =>
  Deno.dlopen("/System/Library/Frameworks/Security.framework/Security", {
    SecItemCopyMatching: { parameters: ["pointer", "buffer"], result: "i32" },
    SecItemUpdate: { parameters: ["pointer", "pointer"], result: "i32" },
    SecItemAdd: { parameters: ["pointer", "pointer"], result: "i32" },
    kSecClass: { type: "pointer" },
    kSecClassGenericPassword: { type: "pointer" },
    kSecAttrService: { type: "pointer" },
    kSecAttrAccount: { type: "pointer" },
    kSecValueData: { type: "pointer" },
    kSecReturnData: { type: "pointer" },
    kSecMatchLimit: { type: "pointer" },
    kSecMatchLimitOne: { type: "pointer" },
    kSecUseAuthenticationUI: { type: "pointer" },
    kSecUseAuthenticationUIFail: { type: "pointer" },
  });
