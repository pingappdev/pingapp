import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "../api/hooks";
import { useRouter } from "../routing";
import { safeReturnTo } from "./return-to";

/** Check the cookie before downloading wallet code or private dashboard views. */
export default function SessionGate({ children }: { children: ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const [admitted, setAdmitted] = useState(false);

  useEffect(() => {
    if (admitted || !session.isSuccess) return;
    if (session.data) {
      setAdmitted(true);
      return;
    }
    const returnTo = safeReturnTo(window.location.pathname + window.location.search);
    router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [admitted, session.isSuccess, session.data, router]);

  // Once loaded, AuthGate owns session expiry and wallet-switching recovery.
  if (admitted) return <>{children}</>;

  if (session.isError) {
    return (
      <main className="premium-workspace contact-page section">
        <div className="card settings-card" style={{ maxWidth: 540, margin: "60px auto" }}>
          <h1>We couldn’t check your session.</h1>
          <p role="alert">{session.error.message}</p>
          <button
            className="button accent"
            disabled={session.isFetching}
            onClick={() => void session.refetch()}
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (!session.data) {
    return (
      <main className="premium-workspace contact-page section" role="status">
        Opening your workspace…
      </main>
    );
  }

  return <>{children}</>;
}
