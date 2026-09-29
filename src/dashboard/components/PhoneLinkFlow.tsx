import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { InputOTP, InputOTPSlot } from "@/components/ui/input-otp";
import { ApiError } from "../../api/client";
import { qk, useCancelClaim, useRequestOtp, useUnlinkPhone, useVerifyOtp } from "../../api/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/useAuth";
import PhoneInput from "./PhoneInput";

type Step = "phone" | "code";

function retrySeconds(error: ApiError): number | null {
  const value = error.details?.retryAfterSec;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.ceil(value)) : null;
}

function countdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0
    ? `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
    : `${remainingSeconds}s`;
}

function linkedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type WebOtpCredential = Credential & { code: string };

export default function PhoneLinkFlow({
  onLinked,
  compact = false,
}: {
  onLinked?: (res: { readyIntents: number }) => void;
  compact?: boolean;
}) {
  const { me, withReauth } = useAuth();
  const queryClient = useQueryClient();
  const requestOtp = useRequestOtp();
  const verifyOtp = useVerifyOtp();
  const verifyCode = verifyOtp.mutateAsync;
  const unlinkPhone = useUnlinkPhone();
  const cancelClaim = useCancelClaim();
  const [step, setStep] = useState<Step>("phone");
  const [changing, setChanging] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [phoneForCode, setPhoneForCode] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [claimMessage, setClaimMessage] = useState("");
  const [resendUntil, setResendUntil] = useState(0);
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [sendingCode, setSendingCode] = useState(false);
  const [otpGeneration, setOtpGeneration] = useState(0);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const attemptedCodes = useRef(new Set<string>());
  const requestInFlight = useRef(false);
  const verificationInFlight = useRef(false);
  const webOtpController = useRef<AbortController | null>(null);
  const secondsUntilResend = Math.max(0, Math.ceil((resendUntil - now) / 1000));
  const secondsUntilRetry = Math.max(0, Math.ceil((retryUntil - now) / 1000));

  useEffect(() => {
    if (!resendUntil && !retryUntil) return;
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(() => {
      update();
      if (Date.now() >= Math.max(resendUntil, retryUntil)) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [resendUntil, retryUntil]);

  const abortWebOtp = useCallback(() => {
    webOtpController.current?.abort();
    webOtpController.current = null;
  }, []);

  const invalidatePhoneOwner = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.me }),
      queryClient.invalidateQueries({ queryKey: qk.session }),
    ]);
  }, [queryClient]);

  const submitCode = useCallback(
    async (candidate: string) => {
      if (!/^\d{6}$/.test(candidate) || verificationInFlight.current) return;
      if (attemptedCodes.current.has(candidate)) {
        setErrorMessage("That code was already checked. Enter the latest code from your message.");
        return;
      }
      if (retryUntil > Date.now()) {
        setErrorMessage(`Try again in ${countdown(Math.ceil((retryUntil - Date.now()) / 1000))}.`);
        return;
      }

      attemptedCodes.current.add(candidate);
      verificationInFlight.current = true;
      setCode(candidate);
      setErrorMessage("");
      abortWebOtp();

      try {
        const result = await withReauth(() => verifyCode({ phone: phoneForCode, code: candidate }));
        setErrorMessage("");
        setClaimMessage("");
        setCode("");
        setStep("phone");
        setChanging(false);
        setPhoneDraft("");
        attemptedCodes.current.clear();
        toast.success("Phone number linked");
        if (result.readyIntents > 0) {
          toast.success(
            `${result.readyIntents} pending transfer${result.readyIntents === 1 ? " is" : "s are"} waiting for you. The senders have been notified.`,
          );
        }
        onLinked?.({ readyIntents: result.readyIntents });
      } catch (reason) {
        if (reason instanceof ApiError) {
          if (reason.code === "OTP_INVALID") {
            const attemptsLeft = reason.details?.attemptsLeft;
            setErrorMessage(
              typeof attemptsLeft === "number"
                ? `Incorrect code. ${attemptsLeft} attempts left.`
                : "Incorrect code. Check the code and try again.",
            );
            setCode("");
          } else if (reason.code === "OTP_EXPIRED") {
            attemptedCodes.current.clear();
            setCode("");
            setStep("phone");
            setPhoneDraft(phoneForCode);
            setErrorMessage("That code expired. Request a new code to continue.");
          } else if (reason.code === "PHONE_LINKED_ELSEWHERE") {
            setClaimMessage(reason.message);
            setCode("");
            setStep("phone");
            setChanging(false);
            await invalidatePhoneOwner();
          } else if (reason.code === "RATE_LIMITED") {
            const seconds = retrySeconds(reason);
            if (seconds !== null) setRetryUntil(Date.now() + seconds * 1000);
            attemptedCodes.current.delete(candidate);
            setErrorMessage(reason.message);
          } else {
            attemptedCodes.current.delete(candidate);
            setErrorMessage(reason.message);
            setCode("");
          }
        } else {
          attemptedCodes.current.delete(candidate);
          setCode("");
          setErrorMessage((reason as Error).message || "Could not verify that code.");
        }
      } finally {
        verificationInFlight.current = false;
      }
    },
    [abortWebOtp, invalidatePhoneOwner, onLinked, phoneForCode, retryUntil, verifyCode, withReauth],
  );

  useEffect(() => {
    if (step !== "code" || otpGeneration === 0 || typeof window === "undefined") return;
    if (!("OTPCredential" in window) || !navigator.credentials) return;

    const controller = new AbortController();
    webOtpController.current?.abort();
    webOtpController.current = controller;
    const options = {
      otp: { transport: ["sms"] },
      signal: controller.signal,
    } as CredentialRequestOptions;

    void navigator.credentials
      .get(options)
      .then((credential) => {
        const receivedCode = (credential as WebOtpCredential | null)?.code;
        if (typeof receivedCode === "string" && /^\d{6}$/.test(receivedCode)) {
          setCode(receivedCode);
          void submitCode(receivedCode);
        }
      })
      .catch(() => undefined);

    return () => {
      controller.abort();
      if (webOtpController.current === controller) webOtpController.current = null;
    };
  }, [otpGeneration, step, submitCode]);

  async function sendCode(phone: string) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setSendingCode(true);
    setErrorMessage("");
    setClaimMessage("");
    attemptedCodes.current.clear();
    abortWebOtp();
    try {
      const response = await withReauth(() => requestOtp.mutateAsync(phone));
      setPhoneDraft(phone);
      setPhoneForCode(phone);
      setMaskedPhone(response.phoneMasked);
      setResendUntil(Date.now() + Math.max(0, response.resendAfterSec) * 1000);
      setRetryUntil(0);
      setCode("");
      setStep("code");
      setOtpGeneration((generation) => generation + 1);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "RATE_LIMITED") {
        const seconds = retrySeconds(reason);
        if (seconds !== null) setResendUntil(Date.now() + seconds * 1000);
      }
      if (reason instanceof ApiError && reason.code === "CLAIM_PENDING") {
        await invalidatePhoneOwner();
      }
      setErrorMessage((reason as Error).message || "Could not send a verification code.");
    } finally {
      requestInFlight.current = false;
      setSendingCode(false);
    }
  }

  function changeNumber() {
    abortWebOtp();
    setChanging(Boolean(me?.phone));
    setPhoneDraft("");
    setCode("");
    setErrorMessage("");
    setStep("phone");
    attemptedCodes.current.clear();
  }

  async function unlink() {
    try {
      await withReauth(() => unlinkPhone.mutateAsync());
      setUnlinkOpen(false);
      setChanging(false);
      toast.success("Phone number removed");
    } catch (reason) {
      toast.error((reason as Error).message || "Could not remove your phone number.");
    }
  }

  async function cancelPendingClaim() {
    try {
      await cancelClaim.mutateAsync();
      setClaimMessage("");
      toast.success("Review request canceled");
    } catch (reason) {
      toast.error((reason as Error).message || "Could not cancel the review request.");
    }
  }

  const linkedPhone = !changing ? me?.phone : null;
  const content = (
    <div>
      {linkedPhone ? (
        <>
          <div className="settings-address" style={{ display: "grid", gap: 8 }}>
            <span className="pill" style={{ justifySelf: "start" }}>
              <Check size={12} /> Linked
            </span>
            <strong>{linkedPhone.masked}</strong>
            <span className="field-help" style={{ margin: 0 }}>
              Linked {linkedDate(linkedPhone.linkedAt)}
            </span>
          </div>
          <div className="settings-buttons">
            <button
              type="button"
              className="button outline"
              disabled={Boolean(me?.pendingClaim)}
              onClick={changeNumber}
            >
              Change number
            </button>
            <button type="button" className="button outline" onClick={() => setUnlinkOpen(true)}>
              Remove
            </button>
          </div>
          {me?.pendingClaim && (
            <p className="field-help" role="status">
              Cancel your open review request before changing to another number.
            </p>
          )}
        </>
      ) : !me?.pendingClaim ? (
        step === "phone" ? (
          <div>
            <PhoneInput
              value={phoneDraft}
              onChange={(value) => {
                setPhoneDraft(value ?? "");
                setErrorMessage("");
              }}
              disabled={sendingCode || requestOtp.isPending}
            />
            <p className="field-help">
              We&apos;ll text you a 6-digit code. Standard SMS rates may apply.
              {changing && " Your current number stays linked until the new number is verified."}
            </p>
            {errorMessage && (
              <p className="field-help" role="alert">
                {errorMessage}
              </p>
            )}
            <div className="settings-buttons">
              <button
                type="button"
                className="button accent"
                disabled={
                  !phoneDraft || sendingCode || requestOtp.isPending || secondsUntilResend > 0
                }
                onClick={() => void sendCode(phoneDraft)}
              >
                {sendingCode || requestOtp.isPending
                  ? "Sending…"
                  : secondsUntilResend > 0
                    ? `Try again in ${countdown(secondsUntilResend)}`
                    : "Send code"}
              </button>
              {changing && (
                <button
                  type="button"
                  className="button outline"
                  onClick={() => {
                    setChanging(false);
                    setPhoneDraft("");
                    setErrorMessage("");
                  }}
                  disabled={sendingCode}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <p className="field-help" style={{ marginTop: 0 }}>
              Enter the 6-digit code sent to {maskedPhone || phoneForCode}.
            </p>
            <InputOTP
              maxLength={6}
              value={code}
              onChange={(value) => {
                setCode(value.replace(/\D/g, "").slice(0, 6));
                setErrorMessage("");
              }}
              onComplete={(value) => void submitCode(value)}
              pattern="^[0-9]*$"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Six-digit verification code"
              disabled={verifyOtp.isPending || requestOtp.isPending || sendingCode}
              containerClassName="settings-buttons"
            >
              {Array.from({ length: 6 }, (_, index) => (
                <InputOTPSlot key={index} index={index} />
              ))}
            </InputOTP>
            {errorMessage && (
              <p className="field-help" role="alert">
                {errorMessage}
              </p>
            )}
            {secondsUntilRetry > 0 && (
              <p className="field-help" role="status">
                Try again in {countdown(secondsUntilRetry)}.
              </p>
            )}
            <div className="settings-buttons">
              <button
                type="button"
                className="button outline"
                disabled={secondsUntilResend > 0 || requestOtp.isPending || sendingCode}
                onClick={() => void sendCode(phoneForCode)}
              >
                {sendingCode || requestOtp.isPending
                  ? "Sending…"
                  : secondsUntilResend > 0
                    ? `Resend in ${countdown(secondsUntilResend)}`
                    : "Resend code"}
              </button>
              {code.length === 6 && !verifyOtp.isPending && secondsUntilRetry === 0 && (
                <button
                  type="button"
                  className="button accent"
                  onClick={() => void submitCode(code)}
                >
                  Verify code
                </button>
              )}
              <button
                type="button"
                className="button outline"
                onClick={changeNumber}
                disabled={verifyOtp.isPending || sendingCode}
              >
                Change number
              </button>
              {verifyOtp.isPending && (
                <LoaderCircle size={16} className="spin" aria-label="Verifying" />
              )}
            </div>
          </div>
        )
      ) : null}

      {claimMessage && !me?.pendingClaim && (
        <div className="notice" role="status">
          <p>{claimMessage}</p>
        </div>
      )}
      {me?.pendingClaim && (
        <div className="notice" role="status" style={{ alignItems: "center" }}>
          <div>
            <strong>Under review</strong>
            <p>Your request to link {me.pendingClaim.phoneMasked} is under manual review.</p>
            {claimMessage && <p>{claimMessage}</p>}
          </div>
          <button
            type="button"
            disabled={cancelClaim.isPending}
            onClick={() => void cancelPendingClaim()}
          >
            {cancelClaim.isPending ? "Canceling…" : "Cancel request"}
          </button>
        </div>
      )}

      <AlertDialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
        <AlertDialogContent className="workspace-alert">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove your phone number?</AlertDialogTitle>
            <AlertDialogDescription>
              People won&apos;t be able to send to you by phone number anymore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlinkPhone.isPending}>Keep number</AlertDialogCancel>
            <AlertDialogAction
              className="button accent"
              disabled={unlinkPhone.isPending}
              onClick={(event) => {
                event.preventDefault();
                void unlink();
              }}
            >
              {unlinkPhone.isPending ? "Removing…" : "Remove number"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  if (compact) return content;
  return (
    <section className="card settings-card">
      <h2>Phone verification</h2>
      {content}
    </section>
  );
}
