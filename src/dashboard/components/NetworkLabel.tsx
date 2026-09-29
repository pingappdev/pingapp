export default function NetworkLabel({ _network }: { _network?: string }) {
  return (
    <span className="network-label network-label-robinhood">
      <img src="/assets/brands/robinhood.svg" alt="" width={153} height={20} />
      <span className="sr-only">Robinhood Chain</span>
    </span>
  );
}
