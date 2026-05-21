// Visible "simulation" banner removed — we are entering real trials with the
// banquetas POC in Bosques. Backend SIMULATION_MODE still gates real money
// movement until each safety check is signed off, but the user-facing UI no
// longer advertises a sandbox state.
//
// To re-enable a maintenance/test banner in the future, restore the prior
// implementation and set VITE_SIMULATION_MODE=true at build time.
export default function SimulationBanner() {
  return null;
}
