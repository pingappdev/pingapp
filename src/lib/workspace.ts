import {normalizeNetwork,DEFAULT_NETWORK} from '../chains';
import {z} from 'zod';
import {client} from './supabase';
const address=z.string().regex(/^0x[a-fA-F0-9]{40}$/,'Enter a valid EVM address.').refine(v=>!/^0x0{40}$/i.test(v),'The zero address cannot be used.');
const network=z.enum(['robinhood','ethereum','arbitrum']);
export async function workspaceApi(data?:Record<string,unknown>){
 const db=client();const {data:{user},error:authError}=await db.auth.getUser();if(authError||!user)throw new Error('Please sign in to open your workspace.');
 if(!data){const [p,c,a]=await Promise.all([db.from('profiles').select('*').eq('user_id',user.id).maybeSingle(),db.from('contacts').select('id,name,phone,address,created').eq('user_id',user.id).order('name'),db.from('activity').select('id,hash,network,address,amount,created').eq('user_id',user.id).order('created',{ascending:false}).limit(200)]);for(const r of [p,c,a])if(r.error)throw new Error('Your workspace could not be loaded. Please try again.');return {profile:p.data?{...p.data,network:normalizeNetwork(p.data.network)}:{display_name:'',wallet:'',network:DEFAULT_NETWORK,confirm_transfers:1},contacts:c.data??[],activity:a.data??[],user:{name:user.user_metadata?.full_name??'',email:user.email??''}}}
 if(data.action==='contact'){
  const c=z.object({name:z.string().trim().min(1).max(80),phone:z.string().regex(/^\+[1-9]\d{7,14}$/,'Use an international phone number.'),address}).parse(data);
  const {error}=await db.from('contacts').insert({...c,user_id:user.id});if(error)throw new Error(error.code==='23505'?'This phone number is already in your contacts.':'Your contact could not be saved.');
 }else if(data.action==='delete-contact'){
  const id=z.string().uuid().parse(data.id);const {error}=await db.from('contacts').delete().eq('id',id).eq('user_id',user.id);if(error)throw new Error('Your contact could not be removed.');
 }else if(data.action==='profile'){
  const p=z.object({displayName:z.string().trim().max(80),wallet:z.union([address,z.literal('')]),network,confirmTransfers:z.boolean()}).parse(data);
  const {error}=await db.from('profiles').upsert({user_id:user.id,display_name:p.displayName,wallet:p.wallet,network:p.network,confirm_transfers:p.confirmTransfers?1:0});if(error)throw new Error('Your settings could not be saved.');
 }else if(data.action==='activity'){
  const a=z.object({hash:z.string().regex(/^0x[a-fA-F0-9]{64}$/),network,address,amount:z.string().regex(/^\d+(\.\d{1,18})?$/)}).parse(data);const {error}=await db.from('activity').insert({...a,user_id:user.id});if(error)throw new Error('Your transfer was submitted, but its record could not be saved.');
 }else throw new Error('Unknown action.');
 return workspaceApi();
}
export async function readBalances(address:string,network:string){const data=await fetchBalances({data:{address,network}});return data as {eth:string,usdc:string|null,updated:number}}
