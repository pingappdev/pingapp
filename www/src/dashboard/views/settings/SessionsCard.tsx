import { useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { useRevokeOthers, useRevokeSession, useSessions } from "../../../api/hooks";
import { useAuth } from "../../../auth/useAuth";
import type { SessionInfo } from "../../../api/types";

function describeDevice(userAgent: string): string {
  const browser = /\bEdg(?:e|A|iOS)?\//.test(userAgent)
    ? "Microsoft Edge"
    : /\bOPR\//.test(userAgent)
      ? "Opera"
      : /\b(?:Firefox|FxiOS)\//.test(userAgent)
        ? "Firefox"
        : /\b(?:Chrome|CriOS)\//.test(userAgent)
          ? "Chrome"
          : /\bSafari\//.test(userAgent)
            ? "Safari"
            : "Browser";
  const system = /iPhone|iPad|iPod|iOS/i.test(userAgent)
    ? "iOS"
    : /Android/i.test(userAgent)
      ? "Android"
      : /Macintosh|Mac OS X/i.test(userAgent)
        ? "macOS"
        : /Windows/i.test(userAgent)
          ? "Windows"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : "Unknown device";
  return system === "Unknown device" ? system : `${browser} on ${system}`;
}

function lastActive(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Activity time unavailable"
    : formatDistanceToNow(date, { addSuffix: true });
}

export default function SessionsCard() {
  const sessions = useSessions();
  const revokeSession = useRevokeSession();
  const revokeOthers = useRevokeOthers();
  const { withReauth } = useAuth();
  const [reauthorizingOthers, setReauthorizingOthers] = useState(false);
  const revokingOthersInFlight = useRef(false);
  const otherSessionCount = sessions.data?.filter((session) => !session.current).length ?? 0;

  async function signOutSession(session: SessionInfo) {
    try {
      await revokeSession.mutateAsync(session.id);
      if (!session.current) toast.success("Device signed out");
    } catch (error) {
      toast.error((error as Error).message || "Could not sign out this device.");
    }
  }

  async function signOutOthers() {
    if (revokingOthersInFlight.current) return;
    revokingOthersInFlight.current = true;
    setReauthorizingOthers(true);
    try {
      await withReauth(() => revokeOthers.mutateAsync());
      toast.success("Other devices signed out");
    } catch (error) {
      toast.error((error as Error).message || "Could not sign out other devices.");
    } finally {
      revokingOthersInFlight.current = false;
      setReauthorizingOthers(false);
    }
  }

  return (
    <section className="card settings-card">
      <div className="panel-heading">
        <div>
          <h2>Active sessions</h2>
          <p>Review devices that are signed in to your wallet account.</p>
        </div>
        <button
          type="button"
          className="button outline"
          disabled={otherSessionCount === 0 || reauthorizingOthers || revokeOthers.isPending}
          onClick={() => void signOutOthers()}
        >
          {reauthorizingOthers || revokeOthers.isPending
            ? "Signing out…"
            : "Sign out other devices"}
        </button>
      </div>

      {sessions.isPending ? (
        <p className="field-help" role="status">
          Loading sessions…
        </p>
      ) : sessions.isError ? (
        <p className="field-help" role="alert">
          {sessions.error.message || "Could not load your sessions."}
        </p>
      ) : sessions.data?.length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {sessions.data.map((session) => (
            <li
              key={session.id}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "16px 0",
                borderTop: "1px solid #ffffff12",
              }}
            >
              <div>
                <strong style={{ display: "block", fontSize: 13, fontWeight: 500 }}>
                  {describeDevice(session.userAgent)}
                </strong>
                <span className="field-help" style={{ display: "block", margin: "5px 0 0" }}>
                  Last active {lastActive(session.lastSeenAt)}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                {session.current && <span className="pill">This device</span>}
                <button
                  type="button"
                  className="button outline"
                  disabled={revokeSession.isPending}
                  onClick={() => void signOutSession(session)}
                >
                  {revokeSession.isPending ? (
                    <LoaderCircle size={14} className="spin" aria-label="Signing out" />
                  ) : (
                    "Sign out"
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-help">No active sessions found.</p>
      )}
    </section>
  );
}
