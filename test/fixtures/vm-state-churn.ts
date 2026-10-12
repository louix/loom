/// <reference lib="deno.worker" />
// Creates and removes a VM state directory back to back until `stop` is set, as
// VMs starting and stopping do in the shared temporary directory.
self.onmessage = (event: MessageEvent<{ path: string; stop: Int32Array }>) => {
  const { path, stop } = event.data;
  self.postMessage("churning");
  while (Atomics.load(stop, 0) === 0) {
    Deno.mkdirSync(path);
    Deno.removeSync(path);
  }
  self.postMessage("stopped");
};
