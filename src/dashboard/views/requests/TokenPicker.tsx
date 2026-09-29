import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Token } from "../../../api/types";
import TokenIcon from "../../components/TokenIcon";

export default function TokenPicker({
  tokens,
  selected,
  onSelect,
  disabled = false,
}: {
  tokens: Token[];
  selected: Token | null;
  onSelect: (token: Token) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="send-token-select request-token-picker">
      <label>Token</label>
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="send-token-trigger"
            aria-label="Choose token"
            disabled={disabled}
          >
            {selected ? (
              <>
                <TokenIcon symbol={selected.symbol} logoUrl={selected.logoUrl} />
                <span>
                  <strong>{selected.symbol}</strong>
                  <small>{selected.name.replace(" • Robinhood Token", "")}</small>
                </span>
              </>
            ) : (
              <span>Choose a token</span>
            )}
            <ChevronDown size={16} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="request-token-popover">
          <Command>
            <CommandInput placeholder="Search tokens" aria-label="Search tokens" />
            <CommandList>
              <CommandEmpty>No matching tokens.</CommandEmpty>
              <CommandGroup>
                {tokens.map((token) => (
                  <CommandItem
                    key={token.address}
                    value={`${token.symbol} ${token.name} ${token.address}`}
                    disabled={token.minAmount === null}
                    onSelect={() => {
                      if (token.minAmount !== null) {
                        onSelect(token);
                        setOpen(false);
                      }
                    }}
                  >
                    <TokenIcon symbol={token.symbol} logoUrl={token.logoUrl} />
                    <span className="request-token-option-name">
                      <strong>{token.symbol}</strong>
                      <small>{token.name.replace(" • Robinhood Token", "")}</small>
                    </span>
                    {token.minAmount === null && (
                      <small className="request-token-unavailable">Price unavailable</small>
                    )}
                    {selected?.address.toLowerCase() === token.address.toLowerCase() && (
                      <Check size={15} aria-label="Selected" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected?.minAmount === null && (
        <p className="field-help" role="status">
          This token is unavailable while its price is unknown.
        </p>
      )}
    </div>
  );
}
