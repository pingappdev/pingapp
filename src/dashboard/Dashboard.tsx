import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, Download, Plus, ShieldCheck } from "lucide-react";
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
import { chain } from "../config";
import { navigateTo } from "../navigation";
import { nav } from "./nav";
import { DashboardProvider, useDashboard } from "./state";
import { useIntents } from "../api/hooks";
import { endpoints } from "../api/client";
import { useSearchParams } from "../routing";
import type { Contact } from "../api/types";
import Connection from "./components/Connection";
import NotificationsBell from "./components/NotificationsBell";
import DashboardDialogs from "./components/DashboardDialogs";
import ContactDialog from "./components/ContactDialog";
import RemoveContactDialog from "./components/RemoveContactDialog";
import WorkspaceBanners from "./components/WorkspaceBanners";
import Overview from "./views/Overview";
import Send from "./views/Send";
import Requests from "./views/Requests";
import Contacts from "./views/Contacts";
import Activity from "./views/Activity";
import { activityDirection } from "./views/activityDirection";
import Settings from "./views/Settings";
import { useAuth } from "../auth/useAuth";
import { openAccount } from "../wallet/appkit";
import { trimAddress } from "./format";

export default function Dashboard({ view }: { view: string }) {
  const { me } = useAuth();
  return (
    <DashboardProvider key={me?.id ?? "signed-out"} view={view}>
      <DashboardLayout />
    </DashboardProvider>
  );
}

function DashboardLayout() {
  const { view } = useDashboard();
  const direction = activityDirection(useSearchParams().get("direction"));
  const { me } = useAuth();
  const [contactDialog, setContactDialog] = useState<{ contact: Contact | null } | null>(null);
  const [removeContact, setRemoveContact] = useState<Contact | null>(null);

  useEffect(() => {
    setContactDialog(null);
    setRemoveContact(null);
  }, [view, me?.id]);
  const { data: openIntents } = useIntents("open");
  const readyIntentCount = openIntents?.filter((intent) => intent.status === "ready").length ?? 0;

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
                enum: ["overview", "send", "requests", "contacts", "activity", "settings"],
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
                    {item.id === "requests" && readyIntentCount > 0 && (
                      <span
                        className="nav-count"
                        aria-label={`${readyIntentCount} ready pending sends`}
                      >
                        {readyIntentCount}
                      </span>
                    )}
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
          <div className="dashboard-header-actions">
            <span className="network-name">
              <span className="network-title">Robinhood Chain</span>
              <span className={`chain-environment${chain.testnet ? " testnet" : ""}`}>
                {chain.testnet ? "Testnet" : "Mainnet"}
              </span>
            </span>
            <NotificationsBell />
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
          <WorkspaceBanners />
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
                        : view === "requests"
                          ? "Review pending sends connected to your phone number."
                          : "Manage your profile, phone number, and signed-in devices."}
              </p>
            </div>
            {view === "contacts" ? (
              <button className="button accent" onClick={() => setContactDialog({ contact: null })}>
                <Plus size={17} />
                Add contact
              </button>
            ) : view === "activity" ? (
              <a className="button outline" href={endpoints.transfers.exportUrl(direction)}>
                <Download size={17} />
                Export CSV
              </a>
            ) : (
              <Connection />
            )}
          </div>
          {view === "overview" && <Overview />}
          {view === "contacts" && (
            <Contacts
              onAdd={() => setContactDialog({ contact: null })}
              onEdit={(contact) => setContactDialog({ contact })}
              onRemove={setRemoveContact}
            />
          )}
          {view === "send" && <Send />}
          {view === "requests" && <Requests />}
          {view === "activity" && <Activity />}
          {view === "settings" && <Settings />}
        </main>
      </div>
      <DashboardDialogs />
      <ContactDialog
        open={!!contactDialog}
        contact={contactDialog?.contact ?? null}
        onClose={() => setContactDialog(null)}
      />
      <RemoveContactDialog contact={removeContact} onClose={() => setRemoveContact(null)} />
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
