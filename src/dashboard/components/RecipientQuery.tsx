import { useEffect } from "react";
import { useSearchParams } from "../../routing";
import { useDashboard } from "../state";

export default function RecipientQuery() {
  const params = useSearchParams();
  const to = params.get("to");
  const { setRecipient } = useDashboard();

  useEffect(() => {
    if (to) setRecipient(to);
  }, [to, setRecipient]);

  return null;
}
