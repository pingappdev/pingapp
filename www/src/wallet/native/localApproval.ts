import { PlatformError } from "@/platform";

type Approval = { id: number; reason: string };
let nextId = 0;
let current: Approval | null = null;
let settle: ((accepted: boolean) => void) | undefined;
const listeners = new Set<() => void>();

export const localApproval = {
  getSnapshot: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  finish(id: number, accepted: boolean) {
    if (current?.id !== id) return;
    const complete = settle;
    current = null;
    settle = undefined;
    for (const listener of listeners) listener();
    complete?.(accepted);
  },
  cancel() {
    if (current) this.finish(current.id, false);
  },
  request(reason: string): Promise<void> {
    if (current)
      return Promise.reject(new PlatformError("cancelled", "Another approval is already open."));
    return new Promise((resolve, reject) => {
      current = { id: ++nextId, reason };
      settle = (accepted) =>
        accepted ? resolve() : reject(new PlatformError("cancelled", "The action was cancelled."));
      for (const listener of listeners) listener();
    });
  },
};
