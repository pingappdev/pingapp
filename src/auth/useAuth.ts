import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createSiweMessage } from "viem/siwe";
import { useAccount, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { ApiError, endpoints } from "../api/client";
import { qk, useSession } from "../api/hooks";
import type { Me } from "../api/types";
import { chain } from "../config";
import { openConnect } from "../wallet/appkit";

export type AuthStatus = "loading" | "signed-out" | "signed-in" | "mismatch";

export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/dashboard";
  const path = value.split(/[?#]/, 1)[0];
  return path === "/dashboard" || path.startsWith("/dashboard/") || path.startsWith("/claim/")
    ? value
    : "/dashboard";
}

export function useAuth(): {
  status: AuthStatus;
  me: Me | null;
  address?: string;
  signIn: () => void;
  signOut: () => Promise<void>;
  reauth: () => Promise<void>;
  withReauth: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  const queryClient = useQueryClient();
  const session = useSession();
  const account = useAccount();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const me = session.data ?? null;
  const address = account.isConnected ? account.address : undefined;

  const signOut = useCallback(async () => {
    try {
      await endpoints.auth.logout();
    } finally {
      queryClient.clear();
      queryClient.setQueryData(qk.session, null);
      if (account.isConnected) await disconnectAsync();
    }
  }, [account.isConnected, disconnectAsync, queryClient]);

  const signIn = useCallback(() => {
    void openConnect();
  }, []);

  const reauth = useCallback(async () => {
    if (!me || !address || address.toLowerCase() !== me.address.toLowerCase()) {
      throw new Error("Connect the wallet linked to your PingApp session before confirming.");
    }
    if (account.chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
    const { nonce } = await endpoints.auth.nonce();
    const message = createSiweMessage({
      domain: window.location.host,
      address: me.address,
      uri: window.location.origin,
      version: "1",
      chainId: chain.id,
      nonce,
      issuedAt: new Date(),
      statement: "Confirm a sensitive PingApp action.",
    });
    const signature = await signMessageAsync({ message });
    await endpoints.auth.reauth(message, signature);
    await queryClient.invalidateQueries({ queryKey: qk.me });
    await queryClient.invalidateQueries({ queryKey: qk.session });
  }, [account.chainId, address, me, queryClient, signMessageAsync, switchChainAsync]);

  const withReauth = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "REAUTH_REQUIRED") throw error;
        await reauth();
        return fn();
      }
    },
    [reauth],
  );

  useEffect(() => {
    const unauthenticated = () => {
      queryClient.clear();
      queryClient.setQueryData(qk.session, null);
      if (window.location.pathname.startsWith("/dashboard") || window.location.pathname.startsWith("/claim/")) {
        const returnTo = window.location.pathname + window.location.search;
        window.location.replace(`/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
      }
    };
    window.addEventListener("pingapp:unauthenticated", unauthenticated);
    return () => window.removeEventListener("pingapp:unauthenticated", unauthenticated);
  }, [queryClient]);

  const status: AuthStatus = session.isPending
    ? "loading"
    : !me
      ? "signed-out"
      : address && address.toLowerCase() !== me.address.toLowerCase()
        ? "mismatch"
        : "signed-in";

  return { status, me, address, signIn, signOut, reauth, withReauth };
}
