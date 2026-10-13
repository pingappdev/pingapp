import { useCallback, useEffect, useRef, useState } from "react";
import { platform } from "./index";

const handlers: { close: () => void }[] = [];

/** Close only the most recently opened overlay; consume Back even if it vetoes closure. */
export function closeTopBackHandler(): boolean {
  const top = handlers.at(-1);
  if (!top) return false;
  top.close();
  return true;
}

export function useBackHandler(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!platform.isNative || !open) return;
    const handler = { close: () => latest.current() };
    handlers.push(handler);
    return () => {
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
  }, [open]);
}

/** Track controlled and uncontrolled Radix roots without changing web behavior. */
export function useOverlayBackHandler({
  open,
  defaultOpen,
  onOpenChange: notify,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (open === undefined) setUncontrolledOpen(nextOpen);
      notify?.(nextOpen);
    },
    [open, notify],
  );
  useBackHandler(open ?? uncontrolledOpen, () => onOpenChange(false));
  return onOpenChange;
}
