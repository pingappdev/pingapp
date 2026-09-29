const disconnected = () => new Error("Not connected yet");

export async function workspaceApi(data?: Record<string, unknown>) {
  if (data) throw disconnected();
  return {
    profile: { display_name: "", wallet: "", network: "robinhood", confirm_transfers: 1 },
    contacts: [] as { id: string; name: string; phone: string; address: string }[],
    activity: [] as { id: string; hash: string; network: string; address: string; amount: string; created: number }[],
    user: { name: "", email: "" },
  };
}

export async function readBalances(_address: string, _network: string): Promise<never> {
  throw disconnected();
}
