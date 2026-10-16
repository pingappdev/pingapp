import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "../../../api/client";
import {
  qk,
  useCancelClaim,
  useRequestOtp,
  useUnlinkPhone,
  useVerifyOtp,
} from "../../../api/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../../auth/useAuth";
import { countdown, retrySeconds, type WebOtpCredential } from "./phoneLinkUtils";

type Step = "phone" | "code";

export function usePhoneLinkFlow(
  onLinked?: (res: { readyIntents: number }) => void,
  claimCode?: string,
) {
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
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [otpGeneration, setOtpGeneration] = useState(0);
  const attemptedCodes = useRef(new Set<string>());
  const requestInFlight = useRef(false);
  const verificationInFlight = useRef(false);
  const unlinkInFlight = useRef(false);
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
      setVerifyingCode(true);
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
        setVerifyingCode(false);
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
        if (controller.signal.aborted) return;
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
      const response = await withReauth(() =>
        requestOtp.mutateAsync({
          phone,
          ...(claimCode && /^[A-Za-z0-9]{10}$/.test(claimCode) ? { claimCode } : {}),
        }),
      );
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

  function cancelChange() {
    setChanging(false);
    setPhoneDraft("");
    setErrorMessage("");
  }

  function changeCode(value: string) {
    setCode(value.replace(/\D/g, "").slice(0, 6));
    setErrorMessage("");
  }

  function clearError() {
    setErrorMessage("");
  }

  async function unlink() {
    if (unlinkInFlight.current) return;
    unlinkInFlight.current = true;
    setUnlinking(true);
    try {
      await withReauth(() => unlinkPhone.mutateAsync());
      setUnlinkOpen(false);
      setChanging(false);
      toast.success("Phone number removed");
    } catch (reason) {
      toast.error((reason as Error).message || "Could not remove your phone number.");
    } finally {
      unlinkInFlight.current = false;
      setUnlinking(false);
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

  return {
    me,
    step,
    changing,
    linkedPhone: !changing ? me?.phone : null,
    phoneDraft,
    setPhoneDraft,
    phoneForCode,
    maskedPhone,
    code,
    errorMessage,
    claimMessage,
    secondsUntilResend,
    secondsUntilRetry,
    sendingCode,
    verifyingCode,
    requestPending: requestOtp.isPending,
    verifyPending: verifyOtp.isPending,
    cancelPending: cancelClaim.isPending,
    unlinkPending: unlinkPhone.isPending,
    unlinking,
    unlinkOpen,
    setUnlinkOpen,
    sendCode,
    submitCode,
    changeNumber,
    cancelChange,
    changeCode,
    clearError,
    unlink,
    cancelPendingClaim,
  };
}
