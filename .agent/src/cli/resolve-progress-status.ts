// CLI: reconcile final route status with a progress cancellation marker.
// Env: STATUS, AGENT_PROGRESS_CANCEL_MARKER_FILE/PROGRESS_CANCEL_MARKER_FILE, RUNNER_TEMP
// Outputs: status, cancelled, cancelled_by

import {
  defaultProgressCancelMarkerFile,
  reconcileProgressCancelStatus,
} from "../progress-cancel.js";
import { setOutput } from "../output.js";

const markerFile = defaultProgressCancelMarkerFile();
const result = reconcileProgressCancelStatus({
  status: process.env.STATUS || "failed",
  markerFile,
});

setOutput("status", result.status);
setOutput("cancelled", String(result.cancelled));
setOutput("cancelled_by", result.cancelledBy);

if (result.cancelled) {
  console.log(`Progress cancellation marker detected; reporting cancelled by @${result.cancelledBy}.`);
} else {
  console.log(`No progress cancellation marker detected; reporting ${result.status}.`);
}
