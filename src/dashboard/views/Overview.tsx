import OverviewBalance from "./overview/OverviewBalance";
import OverviewPanels from "./overview/OverviewPanels";
import OverviewSummary from "./overview/OverviewSummary";

export default function Overview() {
  return (
    <>
      <OverviewBalance />
      <OverviewSummary />
      <OverviewPanels />
    </>
  );
}
