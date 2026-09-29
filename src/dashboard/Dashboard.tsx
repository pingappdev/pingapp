import { useEffect } from "react";
import { ArrowLeft, ChevronRight, Download, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "sonner";
import { config } from "../config";
import { navigateTo } from "../navigation";
import { nav } from "./nav";
import { DashboardProvider, useDashboard } from "./state";
import NetworkLabel from "./components/NetworkLabel";
import Connection from "./components/Connection";
import DashboardDialogs from "./components/DashboardDialogs";
import RecipientQuery from "./components/RecipientQuery";
import Overview from "./views/Overview";
import Send from "./views/Send";
import Contacts from "./views/Contacts";
import Activity from "./views/Activity";
import Settings from "./views/Settings";
import { useAuth } from "../auth/useAuth";
import { openAccount } from "../wallet/appkit";
import { trimAddress } from "./format";

export default function Dashboard({ view }: { view: string }) {
  return (
    <DashboardProvider view={view}>
      <DashboardLayout />
    </DashboardProvider>
  );
}

function DashboardLayout() {
  const { view, network, loading, error, load, setModal, exportActivity } = useDashboard();
  const { me } = useAuth();

  useEffect(() => {
    const ctx = (
      document as unknown as {
        modelContext?: { registerTool: (tool: unknown, options: unknown) => void };
      }
    ).modelContext;
    if (!ctx) return;
    const life = new AbortController();
    try {
      ctx.registerTool(
        {
          name: "open_pingapp_view",
          title: "Open PingApp view",
          description:
            "Navigate to an existing dashboard view. Does not submit a transaction or change saved data.",
          inputSchema: {
            type: "object",
            properties: {
              view: {
                type: "string",
                enum: ["overview", "send", "contacts", "activity", "settings"],
              },
            },
            required: ["view"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
          execute: async (input: { view: string }) => {
            if (!nav.some((item) => item.id === input.view))
              throw new Error("Unknown dashboard view");
            navigateTo("/dashboard" + (input.view === "overview" ? "" : "/" + input.view));
            return { view: input.view };
          },
        },
        { signal: life.signal },
      );
    } catch {
      // This browser capability is optional.
    }
    return () => life.abort();
  }, []);

  const pageName = nav.find((item) => item.id === view)?.name;

  return (
    <SidebarProvider className="premium-workspace">
      <DashboardNavigation />
      <Toaster theme="dark" position="bottom-right" richColors />
      <Sidebar className="ping-sidebar">
        <SidebarHeader>
          <a href="/" className="dashboard-logo">
            <img src="/assets/pingapp-logo-1x1.png" alt="" />
            <span>PingApp</span>
          </a>
          <span className="workspace-label">WORKSPACE</span>
        </SidebarHeader>
        <SidebarContent>
          <SidebarMenu>
            {nav.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton asChild isActive={view === item.id}>
                  <a href={"/dashboard" + (item.id === "overview" ? "" : "/" + item.id)}>
                    <item.icon />
                    <span>{item.name}</span>
                    {view === item.id && <span className="nav-active-dot" />}
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarContent>
        <SidebarFooter>
          <div className="sidebar-note">
            <ShieldCheck size={19} />
            <strong>Your keys. Your control.</strong>
            <p>Your funds stay in your wallet.</p>
          </div>
          <a className="back-site" href="/">
            <ArrowLeft size={15} />
            Back to website
          </a>
        </SidebarFooter>
      </Sidebar>
      <div className="dashboard-shell">
        <header className="dashboard-header">
          <div>
            <SidebarTrigger />
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{pageName}</strong>
          </div>
          <div>
            <span className="network-name">
              <NetworkLabel _network={network} />
              <span className="mainnet-label">
                {config.chainKey === "robinhood-testnet" ? "Testnet" : "Mainnet"}
              </span>
            </span>
            <button
              className="account-chip"
              onClick={() => void openAccount()}
              aria-label="Open wallet account"
            >
              {me?.displayName || trimAddress(me?.address ?? "")}
            </button>
          </div>
        </header>
        <main className="dashboard-main">
          <div className="dashboard-title">
            <div>
              <p className="eyebrow">PINGAPP / WORKSPACE</p>
              <h1>{view === "overview" ? "Crypto portfolio" : pageName}</h1>
              <p>
                {view === "overview"
                  ? "Your assets, contacts, and transfers at a glance."
                  : view === "send"
                    ? "Prepare a transfer. Review and approve it in your wallet."
                    : view === "contacts"
                      ? "Manage your private address book and saved recipients."
                      : view === "activity"
                        ? "Review submitted transfers and their on-chain records."
                        : "Manage your profile, wallet, and transfer preferences."}
              </p>
            </div>
            {view === "contacts" ? (
              <button className="button accent" onClick={() => setModal("contact")}>
                <Plus size={17} />
                Add contact
              </button>
            ) : view === "activity" ? (
              <button className="button outline" onClick={exportActivity}>
                <Download size={17} />
                Export CSV
              </button>
            ) : (
              <Connection />
            )}
          </div>
          {loading ? (
            <div className="workspace-loading">
              <RefreshCw className="spin" />
              Opening your workspace…
            </div>
          ) : error ? (
            <div className="error-panel">
              <h2>Your workspace needs a moment.</h2>
              <p>{error}</p>
              <button className="button" onClick={load}>
                Try again
              </button>
              {error.includes("sign in") && (
                <a className="button" href="/login" target="_top">
                  Sign in
                </a>
              )}
            </div>
          ) : (
            <>
              {view === "overview" && <Overview />}
              {view === "contacts" && <Contacts />}
              {view === "send" && <Send />}
              {view === "activity" && <Activity />}
              {view === "settings" && <Settings />}
            </>
          )}
        </main>
      </div>
      <DashboardDialogs />
      <RecipientQuery />
    </SidebarProvider>
  );
}

function DashboardNavigation() {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    const close = () => setOpenMobile(false);
    window.addEventListener("pingapp:navigation-start", close);
    return () => window.removeEventListener("pingapp:navigation-start", close);
  }, [setOpenMobile]);
  return null;
}
