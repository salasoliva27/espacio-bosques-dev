/**
 * SIMULATION_MODE — when true, no real Bitso API calls are made and
 * blockchain transactions are mocked. Safe for local dev and demos.
 *
 * Evaluated lazily so dotenv.config() in index.ts has already run
 * before this getter is called at request-time.
 */
export const SIMULATION_MODE = () => process.env.SIMULATION_MODE === 'true';

/**
 * REALITY_CHECK_ENABLED — when true, every new project must pass the
 * pre-funding Reality Check (market-rate benchmark vs. proposer's
 * estimate) before it can transition to PENDING / open-for-funding.
 * Defaults to true in simulation mode so the gate is exercised in dev.
 */
export const REALITY_CHECK_ENABLED = () => {
  const explicit = process.env.REALITY_CHECK_ENABLED;
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return SIMULATION_MODE();
};
