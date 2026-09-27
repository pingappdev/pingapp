// Network values verified against https://docs.robinhood.com/chain/connecting/.
export type Chain={name:string,id:string,explorer:string,rpc:string,usdc?:string};
export const DEFAULT_NETWORK='robinhood';
export const chains:Record<string,Chain>={
 robinhood:{name:'Robinhood Chain',id:'0x1237',explorer:'https://robinhoodchain.blockscout.com',rpc:'https://rpc.mainnet.chain.robinhood.com'},
 ethereum:{name:'Ethereum',id:'0x1',explorer:'https://etherscan.io',rpc:'https://ethereum-rpc.publicnode.com',usdc:'0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'},
 arbitrum:{name:'Arbitrum',id:'0xa4b1',explorer:'https://arbiscan.io',rpc:'https://arb1.arbitrum.io/rpc',usdc:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831'}
};
// Existing transfer records retain their actual chain; Base is no longer selectable for new transfers.
export const activityChains:Record<string,Chain>={...chains,base:{name:'Base (historical)',id:'0x2105',explorer:'https://basescan.org',rpc:''}};
export const normalizeNetwork=(network:string)=>Object.hasOwn(chains,network)?network:DEFAULT_NETWORK;
export type WalletProvider={request:(a:{method:string,params?:unknown[]})=>Promise<unknown>};
export async function ensureWalletNetwork(wallet:WalletProvider,network:string){
 if(!Object.hasOwn(chains,network))throw new Error('Select a supported network.');
 const chain=chains[network];
 if(await wallet.request({method:'eth_chainId'})!==chain.id){
  try{await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:chain.id}]})}
  catch(error){
   const e=error as {code?:number,data?:{originalError?:{code?:number}}};
   if(e.code!==4902&&e.data?.originalError?.code!==4902)throw error;
   await wallet.request({method:'wallet_addEthereumChain',params:[{chainId:chain.id,chainName:chain.name,nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[chain.rpc],blockExplorerUrls:[chain.explorer]}]});
   await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId:chain.id}]});
  }
 }
 if(await wallet.request({method:'eth_chainId'})!==chain.id)throw new Error('Select '+chain.name+' in your wallet before sending.');
}
