import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDashboard } from "../state";
import ContactDialog from "./ContactDialog";
import ReceiveDialog from "./ReceiveDialog";
import RemoveContactDialog from "./RemoveContactDialog";
import ReviewDialog from "./ReviewDialog";
import WalletDialog from "./WalletDialog";

export default function DashboardDialogs() {
  const { modal, busy, setModal } = useDashboard();

  return (
    <>
      <Dialog
        open={!!modal}
        onOpenChange={(open) => {
          if (!open && !busy) setModal("");
        }}
      >
        <DialogContent className="ping-dialog">
          <DialogTitle>
            {modal === "contact"
              ? "Add a contact"
              : modal === "receive"
                ? "Receive in your wallet"
                : "Connect your wallet"}
          </DialogTitle>
          <DialogDescription>
            {modal === "contact"
              ? "Save someone you know. Confirm their wallet address before adding it."
              : modal === "receive"
                ? "Share your public address. Only receive assets on the selected network."
                : "Your keys stay with you. Connect a browser wallet or add an address to view its balances."}
          </DialogDescription>
          {modal === "contact" && <ContactDialog />}
          {modal === "receive" && <ReceiveDialog />}
          {modal === "wallet" && <WalletDialog />}
        </DialogContent>
      </Dialog>
      <ReviewDialog />
      <RemoveContactDialog />
    </>
  );
}
