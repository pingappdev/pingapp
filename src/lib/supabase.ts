import { supabase as generated } from "@/integrations/supabase/client";

export const supabase = generated;

export function client() {
  if (!supabase) throw new Error("The workspace is not connected yet.");
  return supabase;
}
