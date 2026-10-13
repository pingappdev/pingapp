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
export function useOverlayBackHandler(props: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen ?? false);
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (props.open === undefined) setUncontrolledOpen(open);
      props.onOpenChange?.(open);
    },
    [props.open, props.onOpenChange],
  );
  useBackHandler(props.open ?? uncontrolledOpen, () => onOpenChange(false));
  return onOpenChange;
}
