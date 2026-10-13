import NativeWalletLifecycleDialog from "./NativeWalletLifecycleDialog";

export default function NativeDeleteAccountCard() {
  return <section className="card settings-card">
    <h2>Delete account</h2>
    <p>Deletes your PingApp account (phone link, contacts, history). Funds stay on-chain in this wallet.</p>
    <NativeWalletLifecycleDialog action="delete" />
  </section>;
}
