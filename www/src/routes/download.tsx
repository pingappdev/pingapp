import { createFileRoute, Link } from "@tanstack/react-router";

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
          <p className="download-note">
            iOS build arrives after the first public release. Prefer the web dashboard in the
            meantime?{" "}
            <Link to="/dashboard" className="download-link">
              Open app
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="download-features">
        <p className="download-eyebrow">What's inside</p>
        <h2>Everything the dashboard does</h2>
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
