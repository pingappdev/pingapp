import { ArrowUpRight, History, Hourglass, LayoutGrid, Settings, Users } from "lucide-react";

export const nav = [
  { id: "overview", name: "Overview", icon: LayoutGrid },
  { id: "send", name: "Send crypto", icon: ArrowUpRight },
  { id: "requests", name: "Pending sends", icon: Hourglass },
  { id: "contacts", name: "Contacts", icon: Users },
  { id: "activity", name: "Activity", icon: History },
  { id: "settings", name: "Settings", icon: Settings },
];
