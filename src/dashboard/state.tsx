import {
  createContext,
  useContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useDashboardActions } from "./useDashboardActions";
import { useDashboardState } from "./useDashboardState";

export type Contact = { id: string; name: string; phone: string; address: string };
export type Activity = {
  id: string;
  hash: string;
  network: string;
  address: string;
  amount: string;
  created: number;
};
export type Profile = {
  display_name: string;
  wallet: string;
  network: string;
  confirm_transfers: number;
};
export type Workspace = {
  profile: Profile;
  contacts: Contact[];
  activity: Activity[];
  user: { name: string; email: string };
};
export type Balance = { eth: string; usdc: string | null; updated: number };

export type DashboardBaseState = {
  view: string;
  data: Workspace | null;
  error: string;
  loading: boolean;
  busy: boolean;
  modal: string;
  query: string;
  remove: Contact | null;
  balance: Balance | null;
  balanceError: string;
  balanceLoading: boolean;
  recipient: string;
  amount: string;
  review: boolean;
  approved: boolean;
  txHash: string;
  name: string;
  confirm: boolean;
  activityFilter: string;
  profile: Profile;
  network: string;
  wallet: string;
  contacts: Contact[];
  history: Activity[];
  currentContact: Contact | undefined;
  destination: string;
  setData: Dispatch<SetStateAction<Workspace | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setModal: Dispatch<SetStateAction<string>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setRemove: Dispatch<SetStateAction<Contact | null>>;
  setBalance: Dispatch<SetStateAction<Balance | null>>;
  setBalanceError: Dispatch<SetStateAction<string>>;
  setBalanceLoading: Dispatch<SetStateAction<boolean>>;
  setRecipient: Dispatch<SetStateAction<string>>;
  setAmount: Dispatch<SetStateAction<string>>;
  setReview: Dispatch<SetStateAction<boolean>>;
  setApproved: Dispatch<SetStateAction<boolean>>;
  setTxHash: Dispatch<SetStateAction<string>>;
  setName: Dispatch<SetStateAction<string>>;
  setConfirm: Dispatch<SetStateAction<boolean>>;
  setActivityFilter: Dispatch<SetStateAction<string>>;
  load: () => Promise<void>;
  refreshBalance: () => Promise<void>;
};

export type DashboardActions = {
  saveProfile: (profile: Partial<Profile>) => Promise<void>;
  connect: () => Promise<void>;
  copy: (value: string) => Promise<void>;
  submitSend: () => Promise<void>;
  sendTransaction: () => Promise<void>;
  filtered: Contact[];
  shownHistory: Activity[];
  exportActivity: () => void;
};

export type DashboardContextValue = DashboardBaseState & DashboardActions;

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ view, children }: { view: string; children: ReactNode }) {
  const state = useDashboardState(view);
  const actions = useDashboardActions(state);

  return (
    <DashboardContext.Provider value={{ ...state, ...actions }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard must be used inside DashboardProvider");
  return value;
}
