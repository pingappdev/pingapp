import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { ApiError } from "../api/client";
import { qk, useClaim } from "../api/hooks";
import type { ClaimView, Me } from "../api/types";
import { useAuth, safeReturnTo } from "../auth/useAuth";
import { explorerAddress } from "../config";
import { WalletProvider } from "./appkit";
import ClaimSafetyBox from "./ClaimSafetyBox";
import PhoneLinkFlow from "../dashboard/components/PhoneLinkFlow";
import TokenIcon from "../dashboard/components/TokenIcon";

export default function ClientClaim({ code }: { code: string }) {
  return (
    <WalletProvider>
      <ClaimContent code={code} />
    </WalletProvider>
  );
}

function ClaimContent({ code }: { code: string }) {
  const claimQuery = useClaim(code);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const claimPath = /^[A-Za-z0-9]{10}$/.test(code) ? `/claim/${code}` : "/dashboard";
  const returnTo = safeReturnTo(claimPath);
  const loginHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;

  useEffect(() => {
    if (auth.status === "signed-in")
      void queryClient.invalidateQueries({ queryKey: qk.claim(code), exact: true });
  }, [auth.status, auth.me?.id, auth.me?.phone?.linkedAt, code, queryClient]);

  const notFound = claimQuery.error instanceof ApiError && claimQuery.error.status === 404;

  return (
    <main className="contact-page section claim-page">
      <a className="wordmark" href="/">
        PingApp
      </a>
      <div className="card settings-card claim-card">
        {claimQuery.isPending && !claimQuery.data ? (
          <p className="claim-loading" role="status">
            <LoaderCircle size={17} className="spin" /> Checking this invite…
          </p>
        ) : claimQuery.error && !claimQuery.data ? (
          <div className="claim-state" role={notFound ? "status" : "alert"}>
            <h1>{notFound ? "This invite link isn't valid." : "This invite could not load."}</h1>
            <p>
              {notFound
                ? "The link may have expired, been canceled, or been copied incorrectly."
                : claimQuery.error.message}
            </p>
            {!notFound && (
              <button
                className="button outline"
                type="button"
                onClick={() => void claimQuery.refetch()}
              >
                <RefreshCw size={15} /> Try again
              </button>
            )}
            <a className="text-link" href="/">
              Open PingApp
            </a>
          </div>
        ) : claimQuery.data ? (
          <>
            <ClaimSummary claim={claimQuery.data} />
            {claimQuery.error && (
              <p className="claim-refresh-error" role="status">
                We couldn&apos;t refresh this invite. Showing the last status we received.
                <button
                  className="text-link"
                  type="button"
                  onClick={() => void claimQuery.refetch()}
                >
                  Refresh
                </button>
              </p>
            )}
            {claimQuery.data.status === "completed" ? (
              <div className="claim-state">
                <span className="claim-status-icon">
                  <Check size={17} />
                </span>
                <h2>This transfer is marked completed.</h2>
                <p>
                  The transfer associated with this invite is marked completed. Check with the
                  sender if you need to confirm the destination.
                </p>
                {auth.status === "signed-in" && auth.me ? (
                  <div className="claim-actions">
                    <a
                      className="button outline"
                      href={explorerAddress(auth.me.address)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View connected wallet in explorer <ArrowUpRight size={15} />
                    </a>
                    <a className="button outline" href="/dashboard">
                      Open dashboard <ArrowUpRight size={15} />
                    </a>
                  </div>
                ) : (
                  <a className="button outline" href={loginHref}>
                    Open PingApp <ArrowUpRight size={15} />
                  </a>
                )}
              </div>
            ) : claimQuery.data.status === "ready" ? (
              <ClaimReadyStep
                senderDisplayName={claimQuery.data.senderDisplayName}
                auth={auth}
                loginHref={loginHref}
              />
            ) : claimQuery.data.status === "expired" || claimQuery.data.status === "cancelled" ? (
              <div className="claim-state">
                <h2>
                  {claimQuery.data.status === "expired"
                    ? "This invite has expired."
                    : "This invite was canceled."}
                </h2>
                <p>
                  No transfer can be completed from this invite. Ask the sender if you need an
                  updated link.
                </p>
                <a className="button outline" href="/">
                  Open PingApp <ArrowUpRight size={15} />
                </a>
              </div>
            ) : (
              <ClaimSessionStep
                key={`${code}:${auth.me?.id ?? auth.status}`}
                code={code}
                claim={claimQuery.data}
                loginHref={loginHref}
                refetchClaim={() => claimQuery.refetch()}
              />
            )}
          </>
        ) : (
          <p className="claim-state" role="status">
            This invite is unavailable.
          </p>
        )}
        <ClaimSafetyBox />
      </div>
    </main>
  );
}

function ClaimReadyStep({
  senderDisplayName,
  auth,
  loginHref,
}: {
  senderDisplayName: string;
  auth: ReturnType<typeof useAuth>;
  loginHref: string;
}) {
  const [switchingWallet, setSwitchingWallet] = useState(false);
  const [actionError, setActionError] = useState("");

  return (
    <div className="claim-state">
      <span className="claim-status-icon">
        <Check size={17} />
      </span>
      <h2>The recipient is ready.</h2>
      <p>{senderDisplayName} has been notified and can complete the transfer.</p>
      {auth.status === "loading" && <p role="status">Checking your PingApp session…</p>}
      {auth.status === "error" && (
        <div role="alert">
          <p>{auth.error?.message ?? "We couldn't check your PingApp session."}</p>
          <button className="button outline" type="button" onClick={() => void auth.retrySession()}>
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      )}
      {auth.status === "signed-out" && (
        <div className="claim-actions">
          <button className="button accent" type="button" onClick={auth.signIn}>
            <Wallet size={15} /> Connect wallet
          </button>
          <a className="button outline" href={loginHref}>
            Continue on the sign-in page
          </a>
        </div>
      )}
      {auth.status === "mismatch" && (
        <div>
          <p>The connected wallet differs from this PingApp session.</p>
          {actionError && <p role="alert">{actionError}</p>}
          <button
            className="button accent"
            type="button"
            disabled={switchingWallet}
            onClick={() => {
              setSwitchingWallet(true);
              setActionError("");
              void auth
                .signOut()
                .then(auth.signIn)
                .catch((error: unknown) =>
                  setActionError((error as Error).message || "Could not switch wallets."),
                )
                .finally(() => setSwitchingWallet(false));
            }}
          >
            <Wallet size={15} /> {switchingWallet ? "Switching…" : "Connect wallet"}
          </button>
        </div>
      )}
      {auth.status === "signed-in" && (
        <a className="button outline" href="/dashboard">
          Open dashboard <ArrowUpRight size={15} />
        </a>
      )}
    </div>
  );
}

function ClaimSummary({ claim }: { claim: ClaimView }) {
  const lastTwo = claim.recipientPhoneMasked.match(/(\d{2})\D*$/)?.[1];
  const expiresAt = new Date(claim.expiresAt);
  const expiry = Number.isNaN(expiresAt.getTime())
    ? claim.expiresAt
    : expiresAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <header className="claim-summary">
      <div className="claim-token-line">
        <TokenIcon symbol={claim.token.symbol} logoUrl={claim.token.logoUrl} />
        <span>
          {claim.amount} {claim.token.symbol}
        </span>
      </div>
      <p className="eyebrow">PENDING SEND INVITE</p>
      <h1>
        {claim.senderDisplayName} wants to send you {claim.amount} {claim.token.symbol}
      </h1>
      {claim.note && <blockquote>“{claim.note}”</blockquote>}
      <p className="claim-meta">
        Sent to {claim.recipientPhoneMasked}
        {lastTwo ? ` · Use the number ending in ••${lastTwo}` : ""}
        <br />
        Expires {expiry}
      </p>
    </header>
  );
}

function ClaimSessionStep({
  code,
  claim,
  loginHref,
  refetchClaim,
}: {
  code: string;
  claim: ClaimView;
  loginHref: string;
  refetchClaim: () => Promise<unknown>;
}) {
  const auth = useAuth();
  const [actionError, setActionError] = useState("");
  const [switchingWallet, setSwitchingWallet] = useState(false);

  if (auth.status === "loading") {
    return (
      <div className="claim-state" role="status">
        <LoaderCircle size={17} className="spin" /> Checking your wallet session…
      </div>
    );
  }

  if (auth.status === "error") {
    return (
      <div className="claim-state" role="alert">
        <h2>We couldn&apos;t check your wallet session.</h2>
        <p>{auth.error?.message ?? "Try again to continue."}</p>
        <button className="button outline" type="button" onClick={() => void auth.retrySession()}>
          <RefreshCw size={15} /> Try again
        </button>
      </div>
    );
  }

  if (auth.status === "mismatch") {
    return (
      <div className="claim-state">
        <h2>Your connected wallet differs from this PingApp session.</h2>
        <p>Switch to the wallet for this session, or sign out and connect the intended wallet.</p>
        {actionError && <p role="alert">{actionError}</p>}
        <button
          className="button accent"
          type="button"
          disabled={switchingWallet}
          onClick={() => {
            setSwitchingWallet(true);
            setActionError("");
            void auth
              .signOut()
              .then(auth.signIn)
              .catch((error: unknown) =>
                setActionError((error as Error).message || "Could not switch wallets."),
              )
              .finally(() => setSwitchingWallet(false));
          }}
        >
          <Wallet size={15} /> {switchingWallet ? "Switching…" : "Connect wallet"}
        </button>
      </div>
    );
  }

  if (auth.status === "signed-out") {
    return (
      <div className="claim-state">
        <h2>Connect a wallet to continue.</h2>
        <p>
          Sign in and verify the phone number this invite was sent to. {claim.senderDisplayName} may
          then choose to complete this pending send.
        </p>
        <button className="button accent" type="button" onClick={auth.signIn}>
          <Wallet size={15} /> Connect wallet
        </button>
        <a className="text-link" href="/what-we-do/connect">
          Don&apos;t have a wallet?
        </a>
        <a className="text-link" href={loginHref}>
          Continue on the sign-in page
        </a>
      </div>
    );
  }

  return auth.me ? (
    <ClaimSignedIn
      key={`${code}:${auth.me.id}`}
      code={code}
      claim={claim}
      me={auth.me}
      refetchClaim={refetchClaim}
    />
  ) : null;
}

function ClaimSignedIn({
  code,
  claim,
  me,
  refetchClaim,
}: {
  code: string;
  claim: ClaimView;
  me: Me;
  refetchClaim: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [linkStatus, setLinkStatus] = useState<"idle" | "checking" | "checked">("idle");
  const refreshAfterLink = useCallback(() => {
    setLinkStatus("checking");
    void queryClient.invalidateQueries({ queryKey: qk.claim(code), exact: true }).then(
      () => setLinkStatus("checked"),
      () => setLinkStatus("checked"),
    );
  }, [code, queryClient]);

  return (
    <div className="claim-state">
      <h2>Verify the phone number for this invite.</h2>
      <p>
        This invite is for {claim.recipientPhoneMasked}. Verify that number to notify{" "}
        {claim.senderDisplayName} that the recipient is ready.
      </p>
      {linkStatus !== "idle" && (
        <p className="claim-link-feedback" role="status">
          {linkStatus === "checking"
            ? "Phone verification finished. Checking invite status…"
            : "Phone verification finished. If this invite is still waiting, confirm that the verified number matches the number shown above."}
        </p>
      )}
      {me.phone && claim.status === "pending" && (
        <p className="claim-phone-hint">
          If the linked number is different, use “Change number” below to verify the invite number.
        </p>
      )}
      <PhoneLinkFlow compact onLinked={refreshAfterLink} />
      <div className="claim-actions">
        <button className="button outline" type="button" onClick={() => void refetchClaim()}>
          <RefreshCw size={15} /> Refresh invite status
        </button>
        <a className="button outline" href="/dashboard">
          Open dashboard <ArrowUpRight size={15} />
        </a>
      </div>
    </div>
  );
}
