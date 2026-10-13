import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

type DashboardContextValue = {
  view: string;
  modal: string;
  setModal: Dispatch<SetStateAction<string>>;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function DashboardProvider({ view, children }: { view: string; children: ReactNode }) {
  const [modal, setModal] = useState("");
  useEffect(() => setModal(""), [view]);

  return (
    <DashboardContext.Provider value={{ view, modal, setModal }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard must be used inside DashboardProvider");
  return value;
}
