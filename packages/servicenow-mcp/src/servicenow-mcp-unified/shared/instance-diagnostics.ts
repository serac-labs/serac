/**
 * The published face of `setup-doctor.ts`: the half that reads THE INSTANCE.
 *
 * `setup-doctor.ts` holds two halves either side of a line it documents at
 * length — everything above reads the machine (`runSetupDoctor` and
 * `resolveChain` walk environment variables and every auth.json path on disk,
 * with mtimes), everything below reads the instance through a client the
 * caller's own credentials produced. That line is why `snow_diagnose_setup`
 * carries `transports: ["stdio"]` and `snow_instance_visibility` does not.
 *
 * A subpath in package.json that exports the whole module hands the machine-
 * reading half to every npm consumer, including a multi-tenant backend where
 * one process serves every tenant and "which auth.json won" is the SERVER's
 * answer, not the asker's. That is the same thing the stdio annotation
 * refuses, arriving through the library door instead of the tool door. So
 * `./setup-doctor` resolves here, and this file names what may cross.
 *
 * Deliberately absent, and to stay absent: `runSetupDoctor`, `renderReport`
 * and `SetupReport`. Anything inside this package that wants them imports
 * `./setup-doctor.js` directly — the relative path is not the boundary.
 */

export {
  classifyApiResponse,
  classifyDateCanary,
  classifyInvalidQuery,
  classifyReachability,
  classifyRoles,
  classifyTableRead,
  classifyTokenResponse,
  classifyTransportFailure,
  dateFunctionCanary,
  heldRoles,
  htmlDiagnosis,
  inspectInstanceUrl,
  invalidQueryProbe,
  loadRolesManifest,
  manifestStamp,
  mapProperties,
  probeHeldRoles,
  probeReach,
  probeTableRead,
  readInstanceIdentity,
  summarizeRoleCoverage,
  summarizeTableAccess,
} from "./setup-doctor.js"

export type {
  Check,
  CheckStatus,
  CheckStep,
  DateFunctions,
  DateVerdict,
  HeldRoles,
  InstanceIdentity,
  InvalidQuery,
  InvalidQueryVerdict,
  Observed,
  Probed,
  ProbeClient,
  Reach,
  RoleCoverage,
  TableAdvice,
  TableRead,
  TransportFailure,
} from "./setup-doctor.js"
