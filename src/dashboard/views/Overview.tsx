import OnboardingCard from "../components/OnboardingCard";
import OverviewBalance from "./overview/OverviewBalance";
import OverviewPanels from "./overview/OverviewPanels";
import OverviewSummary from "./overview/OverviewSummary";

export default function Overview() {
  return (
    <>
      <OnboardingCard />
      <OverviewBalance />
      <OverviewSummary />
      <OverviewPanels />
    </>
  );
}
