import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@/routing";
import { platform } from "./index";

export function useRefreshApp() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return () => {
    if (!platform.isNative) return window.location.reload();
    void queryClient
      .resetQueries()
      .then(() => router.invalidate())
      .then(() => {
        window.dispatchEvent(new Event("pingapp:remount"));
      });
  };
}
