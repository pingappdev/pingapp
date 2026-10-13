import AuthGate from "../auth-gate";
import Dashboard from "../dashboard/Dashboard";
import { WalletProvider } from "./appkit";

export default function ClientDashboard({ view }: { view: string }) {
  return (
    <WalletProvider>
      <AuthGate>
        <Dashboard view={view} />
      </AuthGate>
    </WalletProvider>
  );
}
