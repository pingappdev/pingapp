import { useEffect, useRef } from "react";
import { useAuth } from "../auth/useAuth";
import { WalletProvider } from "./appkit";

export default function ClientLogout() {
  return <WalletProvider><LogoutContent /></WalletProvider>;
}

function LogoutContent() {
  const { signOut } = useAuth();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void signOut().finally(() => window.location.replace("/"));
  }, [signOut]);
  return <main className="contact-page section"><div className="workspace-loading">Signing out…</div></main>;
}
