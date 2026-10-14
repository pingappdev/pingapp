import { useState } from "react";
import { platformInfo } from "@/platform";

export default function NoScreenLockChoice({
  busy,
  onContinue,
}: {
  busy: boolean;
  onContinue: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  if (platformInfo.os !== "android") return null;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <p>
        You can continue without a screen lock. Anyone who can use this device can open your wallet,
        send funds and export your private key. A screen lock is recommended.
      </p>
      <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={accepted}
          disabled={busy}
          onChange={(event) => setAccepted(event.target.checked)}
          style={{ marginTop: 4 }}
        />
        <span>I understand the risk of using this wallet without a screen lock.</span>
      </label>
      <button className="button outline" disabled={busy || !accepted} onClick={onContinue}>
        Continue without screen lock
      </button>
    </div>
  );
}
