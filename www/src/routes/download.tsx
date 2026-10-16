import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/download")({
  head: () => ({
    meta: [
      { title: "Download PingApp — Android APK" },
      {
        name: "description",
        content:
          "Install PingApp on Android. Send crypto by phone number, manage private balances, and keep your wallet under your control.",
      },
      { property: "og:title", content: "Download PingApp" },
      {
        property: "og:description",
        content: "Install PingApp on Android to send crypto by phone number.",
      },
    ],
  }),
  component: Download,
});

const features = [
  {
    label: "Phone-first payments",
    text: "Send and receive by phone number instead of long wallet addresses.",
  },
  { label: "Private balances", text: "Shielded USDC and ETH balances, non-custodial by design." },
  {
    label: "Wallet control",
    text: "Your keys stay with you — approve every transfer from the app.",
  },
  {
    label: "Requests & splits",
    text: "Create invoices, payment links, and group splits with QR sharing.",
  },
  {
    label: "Card & controls",
    text: "Spend from a private balance with the card program of your choice.",
  },
  { label: "Recurring & payroll", text: "Schedule regular sends and bounded agent payments." },
];

function Download() {
  return (
    <main className="download-page">
      <section className="download-hero">
        <p className="download-eyebrow">Android · APK</p>
        <h1>Download PingApp</h1>
        <p className="download-lede">
          Every PingApp dashboard feature, in your pocket. Install the Android build and send crypto
          like a text, with the wallet you control.
        </p>

        <div className="download-card">
          <div className="download-card-head">
            <div className="download-card-logo" aria-hidden="true" />
            <div>
              <strong>PingApp for Android</strong>
              <span>APK · Latest build</span>
            </div>
          </div>
          <div className="download-apk-slot" aria-label="Android APK download">
            <span>pingapp.apk</span>
            <small>Download the latest Android release from GitHub.</small>
          </div>
          <a
            className="download-cta"
            href="https://github.com/pingappdev/pingapp/releases/latest/download/pingapp.apk"
          >
            Download .apk
          </a>
        </div>
      </section>

      <section className="download-integrity" aria-labelledby="download-integrity-title">
        <p className="download-eyebrow">Release integrity</p>
        <h2 id="download-integrity-title">Checks for the pinned 0.1.0 release</h2>
        <p className="download-integrity-lede">
          These identifiers apply only to the versioned file below. The download button above
          continues to point to GitHub&apos;s changing latest release.
        </p>
        <dl>
          <div>
            <dt>Version-specific APK</dt>
            <dd>
              <a
                href="https://github.com/pingappdev/pingapp/releases/download/0.1.0/pingapp.apk"
                target="_blank"
                rel="noreferrer"
              >
                pingapp.apk · release 0.1.0
              </a>
            </dd>
          </div>
          <div>
            <dt>Release tag source</dt>
            <dd>
              <code>3791ec74d06c56750a63c1eb54b232c030a55edf</code>
            </dd>
          </div>
          <div>
            <dt>File size</dt>
            <dd>8,884,986 bytes</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>
              <code>7a3d60d1639778319c1378248525fba54cede72966f324f3ad3befed4ceaaec6</code>
            </dd>
          </div>
          <div>
            <dt>Signing certificate SHA-256</dt>
            <dd>
              <code>ae2151813f4a06189870dacd737c686a98e0f63c5ddedfd966603a5994acc965</code>
            </dd>
          </div>
        </dl>
        <p>
          The tag identifies a source revision; no published build attestation verifies that this
          APK was built from it. The SHA-256 and certificate identify the APK bytes and signer only.{" "}
          <a href="/android-releases/0.1.0.json">Machine-readable record</a>.
        </p>
      </section>

      <section className="download-features">
        <p className="download-eyebrow">What's inside</p>
        <h2>Everything the app does</h2>
        <ul>
          {features.map((f) => (
            <li key={f.label}>
              <strong>{f.label}</strong>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="download-steps">
        <p className="download-eyebrow">Install</p>
        <h2>Three steps on Android</h2>
        <ol>
          <li>
            <strong>Download the APK</strong>
            <span>Tap the download button above and keep the file.</span>
          </li>
          <li>
            <strong>Allow installs from this source</strong>
            <span>Android asks once in Settings → Security → Install unknown apps.</span>
          </li>
          <li>
            <strong>Open PingApp and sign in</strong>
            <span>Connect your wallet and verify your phone number to start sending.</span>
          </li>
        </ol>
      </section>
    </main>
  );
}
