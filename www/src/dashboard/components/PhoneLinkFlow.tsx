import { Check, LoaderCircle } from "lucide-react";
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
import PhoneInput from "./PhoneInput";
import { usePhoneLinkFlow } from "../views/settings/usePhoneLinkFlow";
import { countdown } from "../views/settings/phoneLinkUtils";

function linkedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function PhoneLinkFlow({
  onLinked,
  compact = false,
  claimCode,
}: {
  onLinked?: (res: { readyIntents: number }) => void;
  compact?: boolean;
  claimCode?: string;
}) {
  const flow = usePhoneLinkFlow(onLinked, claimCode);
  const {
    me,
    step,
    changing,
    linkedPhone,
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
    requestPending,
    verifyPending,
    cancelPending,
    unlinkPending,
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
  } = flow;

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
                clearError();
              }}
              disabled={sendingCode || requestPending}
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
                disabled={!phoneDraft || sendingCode || requestPending || secondsUntilResend > 0}
                onClick={() => void sendCode(phoneDraft)}
              >
                {sendingCode || requestPending
                  ? "Sending…"
                  : secondsUntilResend > 0
                    ? `Try again in ${countdown(secondsUntilResend)}`
                    : "Send code"}
              </button>
              {changing && (
                <button
                  type="button"
                  className="button outline"
                  onClick={cancelChange}
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
              onChange={changeCode}
              onComplete={(value) => void submitCode(value)}
              pattern="^[0-9]*$"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Six-digit verification code"
              disabled={verifyingCode || verifyPending || requestPending || sendingCode}
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
                disabled={secondsUntilResend > 0 || requestPending || sendingCode || verifyingCode}
                onClick={() => void sendCode(phoneForCode)}
              >
                {sendingCode || requestPending
                  ? "Sending…"
                  : secondsUntilResend > 0
                    ? `Resend in ${countdown(secondsUntilResend)}`
                    : "Resend code"}
              </button>
              {code.length === 6 && !verifyingCode && secondsUntilRetry === 0 && (
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
                disabled={verifyingCode || sendingCode}
              >
                Change number
              </button>
              {verifyingCode && <LoaderCircle size={16} className="spin" aria-label="Verifying" />}
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
          <button type="button" disabled={cancelPending} onClick={() => void cancelPendingClaim()}>
            {cancelPending ? "Canceling…" : "Cancel request"}
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
            <AlertDialogCancel disabled={unlinking || unlinkPending}>Keep number</AlertDialogCancel>
            <AlertDialogAction
              className="button accent"
              disabled={unlinking || unlinkPending}
              onClick={(event) => {
                event.preventDefault();
                void unlink();
              }}
            >
              {unlinking || unlinkPending ? "Removing…" : "Remove number"}
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
