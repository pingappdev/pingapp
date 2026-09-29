export const trimAddress = (address: string) =>
  address ? address.slice(0, 6) + "…" + address.slice(-4) : "No wallet connected";

export const isAddress = (address: string) =>
  /^0x[a-fA-F0-9]{40}$/.test(address) && !/^0x0{40}$/i.test(address);
