import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Circle, LoaderCircle, X } from "lucide-react";
import { useContacts } from "../../api/hooks";
import { useAuth } from "../../auth/useAuth";

type Dismissal = { address: string; dismissed: boolean };

function OnboardingStep({
  href,
  label,
  complete,
  checking = false,
  detail,
}: {
  href: string;
  label: string;
  complete: boolean;
  checking?: boolean;
  detail?: string;
}) {
  return (
    <a className="contact-mini" href={href}>
      <span className="contact-initial">
        {complete ? (
          <Check size={17} aria-label="Complete" />
        ) : checking ? (
          <LoaderCircle size={17} className="spin" aria-label="Checking" />
        ) : (
          <Circle size={17} aria-hidden="true" />
        )}
      </span>
      <span>
        <strong>{label}</strong>
        {detail && <small>{detail}</small>}
      </span>
      <ArrowUpRight size={17} />
    </a>
  );
}

export default function OnboardingCard() {
  const { me } = useAuth();
  const contacts = useContacts();
  const address = me?.address.toLowerCase() ?? null;
  const [dismissal, setDismissal] = useState<Dismissal | null>(null);

  useEffect(() => {
    if (!address) {
      setDismissal(null);
      return;
    }

    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(`pa:onboarding-dismissed:${address}`) === "1";
    } catch {
      dismissed = false;
    }
    setDismissal({ address, dismissed });
  }, [address]);

  if (!me || !address || dismissal?.address !== address || dismissal.dismissed) return null;

  const nameComplete = Boolean(me.displayName.trim());
  const phoneComplete = Boolean(me.phone);
  const contactsComplete = Boolean(contacts.data?.length);
  const contactsChecking = !contacts.data && contacts.isPending;
  const contactsFailed = !contacts.data && Boolean(contacts.error);
  const addressKey = address;

  if (nameComplete && phoneComplete && contactsComplete) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(`pa:onboarding-dismissed:${addressKey}`, "1");
    } catch {
      // Keep the dismissal for this view even when storage is unavailable.
    }
    setDismissal({ address: addressKey, dismissed: true });
  }

  return (
    <section className="card onboarding-card" aria-labelledby="onboarding-title">
      <div className="panel-heading">
        <div>
          <h2 id="onboarding-title">Finish setting up PingApp</h2>
          <p className="field-help">Complete these steps to make receiving and sending easier.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss setup checklist"
          title="Dismiss checklist"
          onClick={dismiss}
        >
          <X size={16} />
        </button>
      </div>
      <OnboardingStep href="/dashboard/settings" label="Add your name" complete={nameComplete} />
      <OnboardingStep href="/dashboard/settings" label="Link your phone" complete={phoneComplete} />
      <OnboardingStep
        href="/dashboard/contacts"
        label={contactsFailed ? "Check your saved contacts" : "Save your first contact"}
        detail={contactsFailed ? "We couldn't confirm whether a recipient is saved." : undefined}
        complete={contactsComplete}
        checking={contactsChecking}
      />
    </section>
  );
}
