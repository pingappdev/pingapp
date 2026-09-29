import { Hourglass } from "lucide-react";

export default function Requests() {
  return (
    <section className="card empty-state">
      <span className="empty-icon">
        <Hourglass size={24} />
      </span>
      <h2>Pending sends</h2>
      <p>Pending sends will appear here soon.</p>
    </section>
  );
}
