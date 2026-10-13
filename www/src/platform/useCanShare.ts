import { useEffect, useState } from "react";
import { platform } from "./index";

/** Keep the browser's synchronous capability check and check the native plugin. */
export function useCanShare() {
  const [available, setAvailable] = useState(
    () => !platform.isNative && typeof navigator !== "undefined" && typeof navigator.share === "function",
  );
  useEffect(() => {
    let active = true;
    void platform.canShare().then((value) => { if (active) setAvailable(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return available;
}
